import type {
  AnthropicBatchLike,
  AnthropicBatchResultRecord,
  AnthropicBatchesCreateTraceArgs,
  CompleteAnthropicBatchTraceArgs,
} from "../../anthropic-batch-types";
import { debugLogger } from "../../debug-logger";
import {
  _internalGetGlobalState,
  _internalResumeSpanWithoutInitialWrite,
  _internalStartSpanWithInitialMerge,
  _internalStartSpanWithInitialMergeAndParentSpanIds,
  getSpanParentObject,
  NOOP_SPAN,
  type BraintrustState,
  type Span,
  withCurrent,
} from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import type {
  AnthropicCreateParams,
  AnthropicMessage,
} from "../../vendor-sdk-types/anthropic";
import {
  isObject,
  MERGE_PATHS_FIELD,
  SpanTypeAttribute,
} from "../../../util/index";
import {
  SpanComponentsV4,
  type SpanComponentsV4Data,
} from "../../../util/span_identifier_v4";
import { anthropicChannels } from "./anthropic-channels";
import {
  extractAnthropicInput,
  extractAnthropicInputMetadata,
  extractAnthropicMetrics,
  extractAnthropicOutput,
  extractAnthropicOutputMetadata,
} from "./anthropic-span-data";

const CUSTOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const BATCH_SPAN_CHUNK_SIZE = 1000;
const MAX_BATCH_ID_LENGTH = 256;
const MAX_PARENT_CONTEXT_LENGTH = 2048;
const REQUEST_COUNT_FIELDS = [
  "canceled",
  "errored",
  "expired",
  "processing",
  "succeeded",
] as const;
const RESULT_TYPES = ["canceled", "errored", "expired", "succeeded"] as const;

type AnthropicBatchResultType = (typeof RESULT_TYPES)[number];
type AnthropicBatchRequestCounts = Record<
  (typeof REQUEST_COUNT_FIELDS)[number],
  number
>;

type BatchContext = {
  batchId: string;
  inputDigest: string;
  operationId: string;
  parent: string;
  startTime: number;
};

type BatchInputRecord = {
  customId: string;
  requestParams: AnthropicCreateParams;
};

class BatchResultsSourceError extends Error {
  public constructor(public readonly sourceError: unknown) {
    super("Anthropic Batch results could not be consumed");
  }
}

type PendingBatchTrace = {
  context: BatchContext;
  state: BraintrustState;
};

const pendingBatchTraces = new Map<string, PendingBatchTrace>();

type ParsedInputs = {
  firstIssue?: Error;
  inputDigest: string;
  inputs: Map<string, BatchInputRecord>;
};

type BatchSpanIds = {
  rootSpanId: string;
  rowId: string;
  spanId: string;
};

type ChildSpanIds = {
  attachmentKeyPrefix: string;
  rowId: string;
  spanId: string;
};

type PreparedBatchSpanIds = {
  batch: BatchSpanIds;
  children: Map<string, ChildSpanIds>;
};

type StartedBatchChild = {
  extractionError?: Error;
  span: Span;
};

type InitializedBatchSpans = {
  children: Set<string>;
  task: boolean;
};

interface BatchResultOutcome {
  error: unknown;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  output: unknown;
}

function read(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function logBatchInstrumentationError(context: string, error: unknown): void {
  debugLogger.debug(`Anthropic Batch instrumentation ${context}:`, error);
}

function validCustomId(value: unknown): value is string {
  return typeof value === "string" && CUSTOM_ID_PATTERN.test(value);
}

function validBatchId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BATCH_ID_LENGTH
  );
}

function validResultType(value: unknown): value is AnthropicBatchResultType {
  return (
    value === "succeeded" ||
    value === "errored" ||
    value === "canceled" ||
    value === "expired"
  );
}

function validSucceededMessage(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return (
    read(value, "type") === "message" &&
    read(value, "role") === "assistant" &&
    Array.isArray(read(value, "content"))
  );
}

async function exportMinimalParent(
  parent: AnthropicBatchesCreateTraceArgs["parent"],
): Promise<string | undefined> {
  let exported: string;
  if ("toStr" in parent) {
    exported = parent.toStr();
  } else {
    exported = await parent.export();
  }
  if (!exported) {
    return undefined;
  }
  const parsed = SpanComponentsV4.fromStr(exported).data;
  const projectId = read(parsed.compute_object_metadata_args, "project_id");
  const projectName = read(parsed.compute_object_metadata_args, "project_name");
  const computeObjectMetadataArgs = isObject(
    parsed.compute_object_metadata_args,
  )
    ? {
        ...(typeof projectId === "string" ? { project_id: projectId } : {}),
        ...(typeof projectName === "string"
          ? { project_name: projectName }
          : {}),
      }
    : undefined;
  if (!parsed.object_id && !computeObjectMetadataArgs) {
    return undefined;
  }
  const routing = parsed.object_id
    ? { object_id: parsed.object_id }
    : { compute_object_metadata_args: computeObjectMetadataArgs ?? {} };
  // SpanComponents requires all three identifiers together.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const minimalParent = new SpanComponentsV4({
    object_type: parsed.object_type,
    ...routing,
    ...(parsed.row_id && parsed.span_id && parsed.root_span_id
      ? {
          row_id: parsed.row_id,
          span_id: parsed.span_id,
          root_span_id: parsed.root_span_id,
        }
      : {}),
  } as SpanComponentsV4Data).toStr();
  return minimalParent.length <= MAX_PARENT_CONTEXT_LENGTH
    ? minimalParent
    : undefined;
}

async function deterministicDigest(namespace: string, ...parts: string[]) {
  const encoded = new TextEncoder().encode(
    [namespace, ...parts].map((part) => `${part.length}:${part}`).join("\0"),
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", encoded),
  );
}

function digestHex(bytes: Uint8Array, length: number): string {
  return Array.from(bytes.slice(0, length))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function digestUuid(bytes: Uint8Array): string {
  const hex = digestHex(bytes, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deterministicAttachmentKey(prefix: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error("Anthropic Batch input contains too many attachments");
  }
  const rawHex = prefix + index.toString(16).padStart(8, "0");
  const variantNibble = (
    (Number.parseInt(rawHex[16] ?? "0", 16) & 0x3) |
    0x8
  ).toString(16);
  const uuidHex = `${rawHex.slice(0, 12)}4${rawHex.slice(13, 16)}${variantNibble}${rawHex.slice(17)}`;
  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`;
}

async function batchSpanIds(operationId: string) {
  const digest = await deterministicDigest(
    "anthropic:batch:span-ids",
    operationId,
  );
  return {
    rootSpanId: digestHex(digest.slice(8), 16),
    rowId: digestUuid(digest),
    spanId: digestHex(digest.slice(16), 8),
  };
}

async function childSpanIds(operationId: string, customId: string) {
  const digest = await deterministicDigest(
    "anthropic:batch:child:span-ids",
    operationId,
    customId,
  );
  return {
    attachmentKeyPrefix: digestHex(digest.slice(4), 12),
    rowId: digestUuid(digest),
    spanId: digestHex(digest.slice(16), 8),
  };
}

const BATCH_ID_CONCURRENCY = 16;

async function prepareBatchSpanIds(
  context: BatchContext,
  inputs: Map<string, BatchInputRecord>,
): Promise<PreparedBatchSpanIds> {
  const batchIdsPromise = batchSpanIds(context.operationId);
  const children = new Map<string, ChildSpanIds>();
  const records = Array.from(inputs.values());
  for (
    let offset = 0;
    offset < records.length;
    offset += BATCH_ID_CONCURRENCY
  ) {
    const chunk = await Promise.all(
      records
        .slice(offset, offset + BATCH_ID_CONCURRENCY)
        .map(
          async (input) =>
            [
              input.customId,
              await childSpanIds(context.operationId, input.customId),
            ] as const,
        ),
    );
    for (const [customId, ids] of chunk) {
      children.set(customId, ids);
    }
  }
  return { batch: await batchIdsPromise, children };
}

const DIGEST_BUFFER_CODE_UNITS = 64 * 1024;

class BoundedDigest {
  private buffer = "";
  private state = new Uint8Array();

  public async update(value: string): Promise<void> {
    let offset = 0;
    while (offset < value.length) {
      let length = Math.min(
        DIGEST_BUFFER_CODE_UNITS - this.buffer.length,
        value.length - offset,
      );
      const end = offset + length;
      if (
        end < value.length &&
        length > 0 &&
        /[\uD800-\uDBFF]/.test(value[end - 1] ?? "") &&
        /[\uDC00-\uDFFF]/.test(value[end] ?? "")
      ) {
        length--;
      }
      if (length === 0) {
        await this.flush();
        continue;
      }
      this.buffer += value.slice(offset, offset + length);
      offset += length;
      if (this.buffer.length === DIGEST_BUFFER_CODE_UNITS) {
        await this.flush();
      }
    }
  }

  public async hex(): Promise<string> {
    await this.flush();
    return digestHex(this.state, 32);
  }

  private async flush(): Promise<void> {
    if (!this.buffer) {
      return;
    }
    const encoded = new TextEncoder().encode(this.buffer);
    const input = new Uint8Array(this.state.length + encoded.length);
    input.set(this.state);
    input.set(encoded, this.state.length);
    this.state = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", input),
    );
    this.buffer = "";
  }
}

async function updateCanonicalDigest(
  digest: BoundedDigest,
  value: unknown,
  ancestors: Set<object> = new Set(),
): Promise<void> {
  if (value === null) {
    await digest.update("null;");
    return;
  }
  if (typeof value === "string") {
    await digest.update(`string:${value.length}:`);
    await digest.update(value);
    await digest.update(";");
    return;
  }
  if (typeof value === "boolean") {
    await digest.update(value ? "boolean:true;" : "boolean:false;");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Anthropic Batch input contains a non-finite number");
    }
    await digest.update(`number:${String(value)};`);
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error("Anthropic Batch input contains a circular value");
    }
    ancestors.add(value);
    try {
      await digest.update(`array:${value.length}:[`);
      for (const entry of value) {
        await updateCanonicalDigest(digest, entry, ancestors);
      }
      await digest.update("];");
    } finally {
      ancestors.delete(value);
    }
    return;
  }
  if (!isObject(value)) {
    throw new Error("Anthropic Batch input contains a non-JSON value");
  }
  if (ancestors.has(value)) {
    throw new Error("Anthropic Batch input contains a circular value");
  }
  ancestors.add(value);
  try {
    await digest.update("object:{");
    for (const key of Object.keys(value).sort()) {
      const entry = read(value, key);
      if (entry === undefined) {
        continue;
      }
      await updateCanonicalDigest(digest, key, ancestors);
      await updateCanonicalDigest(digest, entry, ancestors);
    }
    await digest.update("};");
  } finally {
    ancestors.delete(value);
  }
}

async function readBatchInputs(params: unknown): Promise<ParsedInputs> {
  const inputs = new Map<string, BatchInputRecord>();
  let firstIssue: Error | undefined;
  const inputDigest = new BoundedDigest();
  await inputDigest.update("anthropic:batch:input;");
  const requests = read(params, "requests");
  if (!Array.isArray(requests) || requests.length === 0) {
    firstIssue = new Error("Anthropic Batch input has no requests");
    return {
      firstIssue,
      inputDigest: await inputDigest.hex(),
      inputs,
    };
  }

  for (const request of requests) {
    const customId = read(request, "custom_id");
    const requestParams = read(request, "params");
    if (
      !validCustomId(customId) ||
      inputs.has(customId) ||
      !isObject(requestParams) ||
      !Array.isArray(read(requestParams, "messages")) ||
      typeof read(requestParams, "model") !== "string" ||
      read(requestParams, "stream") === true
    ) {
      firstIssue ??= new Error(
        "Anthropic Batch input contains an invalid request",
      );
      continue;
    }

    try {
      await inputDigest.update("record:");
      await updateCanonicalDigest(inputDigest, {
        custom_id: customId,
        params: requestParams,
      });
      // The checks above establish the narrow surface used by extraction.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const typedRequestParams = requestParams as AnthropicCreateParams;
      inputs.set(customId, {
        customId,
        requestParams: typedRequestParams,
      });
    } catch (error) {
      logBatchInstrumentationError("could not canonicalize batch input", error);
      firstIssue ??= new Error(
        "Anthropic Batch input contains an invalid request",
      );
    }
  }

  return {
    ...(firstIssue ? { firstIssue } : {}),
    inputDigest: await inputDigest.hex(),
    inputs,
  };
}

async function startBatchSpan(
  context: BatchContext,
  ids: BatchSpanIds,
  state: BraintrustState,
  resume = false,
): Promise<Span> {
  const parent = SpanComponentsV4.fromStr(context.parent);
  const hasParentSpan = Boolean(
    parent.data.row_id && parent.data.span_id && parent.data.root_span_id,
  );
  return withCurrent(
    NOOP_SPAN,
    () =>
      (resume
        ? _internalResumeSpanWithoutInitialWrite
        : _internalStartSpanWithInitialMergeAndParentSpanIds)(
        withSpanInstrumentationName(
          {
            event: {
              id: ids.rowId,
              metadata: {
                batch_id: context.batchId,
                provider: "anthropic",
              },
            },
            name: "anthropic.batch",
            parent: context.parent,
            ...(!hasParentSpan
              ? {
                  parentSpanIds: {
                    parentSpanIds: [],
                    rootSpanId: ids.rootSpanId,
                  },
                }
              : {}),
            spanId: ids.spanId,
            startTime: context.startTime,
            state,
            type: SpanTypeAttribute.TASK,
          },
          INSTRUMENTATION_NAMES.ANTHROPIC,
        ),
      ),
    state,
  );
}

async function startBatchChild(
  context: BatchContext,
  taskParent: string,
  input: BatchInputRecord,
  ids: ChildSpanIds,
  state: BraintrustState,
  resume = false,
): Promise<StartedBatchChild> {
  let spanData: ReturnType<typeof extractAnthropicInput> | undefined;
  let extractionError: Error | undefined;
  if (!resume) {
    try {
      spanData = extractAnthropicInput(input.requestParams, {
        attachmentKey: (index) =>
          deterministicAttachmentKey(ids.attachmentKeyPrefix, index),
        state,
      });
    } catch (error) {
      extractionError =
        error instanceof Error
          ? error
          : new Error("Anthropic Batch input extraction failed");
    }
  }
  const span = withCurrent(
    NOOP_SPAN,
    () =>
      (resume
        ? _internalResumeSpanWithoutInitialWrite
        : _internalStartSpanWithInitialMerge)(
        withSpanInstrumentationName(
          {
            event: {
              id: ids.rowId,
              ...(spanData?.input !== undefined
                ? { input: spanData.input }
                : {}),
              metadata: {
                ...spanData?.metadata,
                provider: "anthropic",
              },
            },
            name: "anthropic.messages.create",
            parent: taskParent,
            spanId: ids.spanId,
            startTime: context.startTime,
            state,
            type: SpanTypeAttribute.LLM,
          },
          INSTRUMENTATION_NAMES.ANTHROPIC,
        ),
      ),
    state,
  );
  return { ...(extractionError ? { extractionError } : {}), span };
}

async function startPreparedBatch(
  inputs: Map<string, BatchInputRecord>,
  context: BatchContext,
  state: BraintrustState,
): Promise<PreparedBatchSpanIds | undefined> {
  let ids: PreparedBatchSpanIds;
  try {
    ids = await prepareBatchSpanIds(context, inputs);
  } catch (error) {
    logBatchInstrumentationError("could not prepare batch span IDs", error);
    return undefined;
  }
  const initialized: InitializedBatchSpans = {
    children: new Set(),
    task: false,
  };
  try {
    const task = await startBatchSpan(context, ids.batch, state);
    initialized.task = true;
    const taskParent = await task.export();
    let processed = 0;
    for (const input of inputs.values()) {
      const childIds = ids.children.get(input.customId);
      if (!childIds) {
        throw new Error("Anthropic Batch child span ID is missing");
      }
      const child = await startBatchChild(
        context,
        taskParent,
        input,
        childIds,
        state,
      );
      initialized.children.add(input.customId);
      processed++;
      if (processed % BATCH_SPAN_CHUNK_SIZE === 0 && processed < inputs.size) {
        await state.bgLogger().flush();
      }
      if (child.extractionError) {
        throw child.extractionError;
      }
    }
    return ids;
  } catch (error) {
    logBatchInstrumentationError("could not start batch spans", error);
    try {
      await endBatchWithError(context, inputs, error, ids, state, initialized);
    } catch (cleanupError) {
      logBatchInstrumentationError(
        "could not close partially started batch spans",
        cleanupError,
      );
    }
    return undefined;
  }
}

async function endBatchWithError(
  context: BatchContext,
  inputs: Map<string, BatchInputRecord>,
  error: unknown,
  ids: PreparedBatchSpanIds,
  state: BraintrustState,
  initialized?: InitializedBatchSpans,
): Promise<void> {
  const endTime = Math.max(getCurrentUnixTimestamp(), context.startTime);
  const task = await startBatchSpan(
    context,
    ids.batch,
    state,
    initialized?.task ?? true,
  );
  const taskParent = await task.export();
  let processed = 0;
  for (const input of inputs.values()) {
    try {
      const childIds = ids.children.get(input.customId);
      if (!childIds) {
        throw new Error("Anthropic Batch child span ID is missing");
      }
      const { span } = await startBatchChild(
        context,
        taskParent,
        input,
        childIds,
        state,
        initialized?.children.has(input.customId) ?? true,
      );
      span.log({ error });
      span.end({ endTime });
    } catch (childError) {
      logBatchInstrumentationError("could not fail child span", childError);
    }
    processed++;
    if (processed % BATCH_SPAN_CHUNK_SIZE === 0 && processed < inputs.size) {
      await state.bgLogger().flush();
    }
  }
  task.log({ error });
  task.end({ endTime });
}

export const interceptAnthropicBatchesCreateTraced: Parameters<
  typeof anthropicChannels.batchesCreateTraced.intercept
>[0] = async (target, thisArg, args) => {
  const startTime = getCurrentUnixTimestamp();
  const state = args[0].state ?? _internalGetGlobalState();
  const preparation = Promise.all([
    readBatchInputs(args[0].params),
    exportMinimalParent(args[0].parent),
  ]).catch((error) => {
    logBatchInstrumentationError("could not prepare batch", error);
    return undefined;
  });
  const batch = await Reflect.apply(target, thisArg, args);
  try {
    const batchId = read(batch, "id");
    const prepared = await preparation;
    if (!validBatchId(batchId) || !prepared) {
      return batch;
    }
    const [inputData, parent] = prepared;
    if (inputData.firstIssue || !parent) {
      logBatchInstrumentationError(
        "skipped invalid batch input",
        inputData.firstIssue ?? new Error("No routable parent is available"),
      );
      return batch;
    }
    const createdAt = parseTimestamp(read(batch, "created_at"));
    const observedAt = getCurrentUnixTimestamp();
    const context: BatchContext = {
      batchId,
      inputDigest: inputData.inputDigest,
      operationId: digestHex(
        await deterministicDigest(
          "anthropic:batch:operation",
          batchId,
          inputData.inputDigest,
          parent,
        ),
        16,
      ),
      parent,
      startTime:
        createdAt !== undefined && createdAt <= observedAt
          ? createdAt
          : startTime,
    };
    if (await startPreparedBatch(inputData.inputs, context, state)) {
      pendingBatchTraces.set(batchId, { context, state });
    }
  } catch (error) {
    logBatchInstrumentationError("could not start batch trace", error);
  }
  return batch;
};

function isBatchResultIterable(
  value: unknown,
): value is Iterable<unknown> | AsyncIterable<unknown> {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  try {
    return (
      typeof Reflect.get(value, Symbol.iterator) === "function" ||
      typeof Reflect.get(value, Symbol.asyncIterator) === "function"
    );
  } catch {
    return false;
  }
}

async function* iterateBatchResults(
  source: CompleteAnthropicBatchTraceArgs["results"],
): AsyncGenerator<unknown> {
  let resolved: Awaited<typeof source>;
  try {
    resolved = await source;
  } catch (error) {
    throw new BatchResultsSourceError(error);
  }
  if (!isBatchResultIterable(resolved)) {
    throw new BatchResultsSourceError(
      new Error("Anthropic Batch results source is not iterable"),
    );
  }
  try {
    for await (const value of resolved) {
      yield value;
    }
  } catch (error) {
    throw new BatchResultsSourceError(error);
  }
}

function resultError(
  result: AnthropicBatchResultRecord["result"],
): Error | undefined {
  switch (result.type) {
    case "succeeded":
      return undefined;
    case "errored": {
      const nested = read(result.error, "error");
      const message = read(nested, "message") ?? read(result.error, "message");
      return new Error(
        typeof message === "string"
          ? message
          : "Anthropic Batch request errored",
      );
    }
    case "canceled":
      return new Error("Anthropic Batch request canceled");
    default:
      return new Error("Anthropic Batch request expired");
  }
}

function batchResultOutcome(
  inputMetadata: Record<string, unknown>,
  record: AnthropicBatchResultRecord,
): BatchResultOutcome {
  if (record.result.type !== "succeeded") {
    return {
      error: resultError(record.result),
      metadata: inputMetadata,
      metrics: {},
      output: null,
    };
  }
  // Successful records are validated before outcome extraction.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const message = record.result.message as AnthropicMessage;
  return {
    error: null,
    metadata: {
      ...inputMetadata,
      ...extractAnthropicOutputMetadata(message),
    },
    metrics: extractAnthropicMetrics(message),
    output: extractAnthropicOutput(message),
  };
}

async function completeBatchResult(
  context: BatchContext,
  taskParent: string,
  endTime: number,
  input: BatchInputRecord,
  record: AnthropicBatchResultRecord,
  ids: ChildSpanIds,
  state: BraintrustState,
): Promise<void> {
  const { span: child } = await startBatchChild(
    context,
    taskParent,
    input,
    ids,
    state,
    true,
  );
  try {
    const outcome = batchResultOutcome(
      extractAnthropicInputMetadata(input.requestParams),
      record,
    );
    child.log({
      [MERGE_PATHS_FIELD]: [["metadata"], ["metrics"]],
      ...outcome,
      metrics: { start: context.startTime, ...outcome.metrics },
    });
  } catch (error) {
    child.log({
      [MERGE_PATHS_FIELD]: [["metadata"], ["metrics"]],
      error,
      metadata: extractAnthropicInputMetadata(input.requestParams),
      metrics: { start: context.startTime },
      output: null,
    });
  } finally {
    child.end({ endTime });
  }
}

async function completeCollectOnlyBatchResult(
  context: BatchContext,
  taskParent: string,
  endTime: number,
  input: BatchInputRecord,
  record: AnthropicBatchResultRecord,
  ids: ChildSpanIds,
  state: BraintrustState,
): Promise<void> {
  let inputData: ReturnType<typeof extractAnthropicInput> | undefined;
  let outcome: BatchResultOutcome;
  try {
    inputData = extractAnthropicInput(input.requestParams, {
      attachmentKey: (index) =>
        deterministicAttachmentKey(ids.attachmentKeyPrefix, index),
      state,
    });
    outcome = batchResultOutcome(inputData.metadata, record);
  } catch (error) {
    outcome = {
      error,
      metadata: {
        model: input.requestParams.model,
        provider: "anthropic",
      },
      metrics: {},
      output: null,
    };
  }
  writeCollectOnlyBatchChild(
    context,
    taskParent,
    endTime,
    {
      id: ids.rowId,
      ...(inputData ? { input: inputData.input } : {}),
      ...outcome,
    },
    ids,
    state,
  );
}

function writeCollectOnlyBatchChild(
  context: BatchContext,
  taskParent: string,
  endTime: number,
  event: BatchResultOutcome & { id: string; input?: unknown },
  ids: ChildSpanIds,
  state: BraintrustState,
): void {
  withCurrent(
    NOOP_SPAN,
    () =>
      _internalStartSpanWithInitialMerge(
        withSpanInstrumentationName(
          {
            event: {
              [MERGE_PATHS_FIELD]: [["metadata"], ["metrics"]],
              ...event,
              metrics: {
                end: endTime,
                start: context.startTime,
                ...event.metrics,
              },
            },
            name: "anthropic.messages.create",
            parent: taskParent,
            spanId: ids.spanId,
            startTime: context.startTime,
            state,
            type: SpanTypeAttribute.LLM,
          },
          INSTRUMENTATION_NAMES.ANTHROPIC,
        ),
      ),
    state,
  );
}

async function failCollectOnlyBatchChild(
  context: BatchContext,
  taskParent: string,
  endTime: number,
  input: BatchInputRecord,
  error: Error,
  ids: ChildSpanIds,
  state: BraintrustState,
): Promise<void> {
  let inputData: ReturnType<typeof extractAnthropicInput> | undefined;
  try {
    inputData = extractAnthropicInput(input.requestParams, {
      attachmentKey: (index) =>
        deterministicAttachmentKey(ids.attachmentKeyPrefix, index),
      state,
    });
  } catch {
    // The terminal provider error still closes the child if input extraction
    // itself fails.
  }
  writeCollectOnlyBatchChild(
    context,
    taskParent,
    endTime,
    {
      error,
      id: ids.rowId,
      ...(inputData ? { input: inputData.input } : {}),
      metadata: inputData?.metadata ?? {
        model: input.requestParams.model,
        provider: "anthropic",
      },
      metrics: {},
      output: null,
    },
    ids,
    state,
  );
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value) / 1000;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function terminalEndTime(batch: AnthropicBatchLike, startTime: number): number {
  const endedAt = parseTimestamp(read(batch, "ended_at"));
  return endedAt !== undefined && endedAt >= startTime
    ? endedAt
    : Math.max(getCurrentUnixTimestamp(), startTime);
}

function parseRequestCounts(
  batch: AnthropicBatchLike,
): AnthropicBatchRequestCounts | undefined {
  const counts = read(batch, "request_counts");
  if (!isObject(counts)) {
    return undefined;
  }
  const parsedCounts: AnthropicBatchRequestCounts = {
    canceled: 0,
    errored: 0,
    expired: 0,
    processing: 0,
    succeeded: 0,
  };
  for (const field of REQUEST_COUNT_FIELDS) {
    const value = read(counts, field);
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return undefined;
    }
    parsedCounts[field] = value;
  }
  return parsedCounts;
}

async function collectOnlyContext(
  batchId: string,
  batch: AnthropicBatchLike,
  inputDigest: string,
  state: BraintrustState,
): Promise<BatchContext | undefined> {
  const parent = await exportMinimalParent(getSpanParentObject({ state }));
  if (!parent) {
    return undefined;
  }
  const observedAt = getCurrentUnixTimestamp();
  const createdAt = parseTimestamp(read(batch, "created_at"));
  return {
    batchId,
    inputDigest,
    operationId: digestHex(
      await deterministicDigest(
        "anthropic:batch:operation",
        batchId,
        inputDigest,
        parent,
      ),
      16,
    ),
    parent,
    startTime:
      createdAt !== undefined && createdAt <= observedAt
        ? createdAt
        : observedAt,
  };
}

async function completeBatch(
  args: CompleteAnthropicBatchTraceArgs,
): Promise<void> {
  const batchId = read(args.batch, "id");
  if (
    !validBatchId(batchId) ||
    read(args.batch, "processing_status") !== "ended"
  ) {
    return;
  }
  const inputData = await readBatchInputs(args.params);
  if (inputData.firstIssue) {
    logBatchInstrumentationError(
      "left batch spans pending",
      inputData.firstIssue,
    );
    return;
  }
  const counts = parseRequestCounts(args.batch);
  if (!counts) {
    logBatchInstrumentationError(
      "left batch spans pending",
      new Error("Anthropic Batch request counts are invalid"),
    );
    return;
  }
  const total = REQUEST_COUNT_FIELDS.reduce(
    (sum, field) => sum + counts[field],
    0,
  );
  if (total !== inputData.inputs.size) {
    logBatchInstrumentationError(
      "left batch spans pending",
      new Error("Anthropic Batch input does not match request counts"),
    );
    return;
  }

  const pendingTrace = pendingBatchTraces.get(batchId);
  const matchingPendingTrace =
    pendingTrace?.context.inputDigest === inputData.inputDigest
      ? pendingTrace
      : undefined;
  const resumesStartedTrace = matchingPendingTrace !== undefined;
  const state =
    args.state ?? matchingPendingTrace?.state ?? _internalGetGlobalState();
  let context = matchingPendingTrace?.context;
  if (!resumesStartedTrace) {
    if (pendingTrace) {
      logBatchInstrumentationError(
        "ignored mismatched pending trace",
        new Error("Anthropic Batch input does not match the created batch"),
      );
    }
    context = await collectOnlyContext(
      batchId,
      args.batch,
      inputData.inputDigest,
      state,
    );
  }
  if (!context) {
    return;
  }
  let spanIds: PreparedBatchSpanIds;
  try {
    spanIds = await prepareBatchSpanIds(context, inputData.inputs);
  } catch (error) {
    logBatchInstrumentationError("could not prepare batch span IDs", error);
    return;
  }

  const endTime = terminalEndTime(args.batch, context.startTime);
  const task = await startBatchSpan(
    context,
    spanIds.batch,
    state,
    resumesStartedTrace,
  );
  const taskParent = await task.export();
  const seen = new Set<string>();
  let firstIssue: Error | undefined;
  const resultCounts: Record<AnthropicBatchResultType, number> = {
    canceled: 0,
    errored: 0,
    expired: 0,
    succeeded: 0,
  };
  // Normalize only after all validation and span setup succeeds. This keeps a
  // lazy provider-owned source untouched when collection exits early.
  const results = Promise.resolve(args.results);
  let consumedResults = 0;
  let completedResults = 0;
  let resultsSourceError: BatchResultsSourceError | undefined;
  try {
    for await (const value of iterateBatchResults(results)) {
      consumedResults++;
      if (consumedResults > total) {
        firstIssue ??= new Error(
          "Anthropic Batch results contain excess records",
        );
        break;
      }
      const customId = read(value, "custom_id");
      const result = read(value, "result");
      const type = read(result, "type");
      if (
        !validCustomId(customId) ||
        !isObject(value) ||
        !isObject(result) ||
        !validResultType(type)
      ) {
        firstIssue ??= new Error("Anthropic Batch result is malformed");
        continue;
      }
      if (seen.has(customId)) {
        firstIssue ??= new Error("Anthropic Batch result is duplicated");
        continue;
      }
      const input = inputData.inputs.get(customId);
      if (!input) {
        firstIssue ??= new Error(
          "Anthropic Batch result has no matching input",
        );
        continue;
      }
      const succeededMessage =
        type === "succeeded" ? read(result, "message") : undefined;
      if (type === "succeeded" && !validSucceededMessage(succeededMessage)) {
        firstIssue ??= new Error(
          "Anthropic Batch succeeded result has an invalid message",
        );
        continue;
      }
      seen.add(customId);
      let record: AnthropicBatchResultRecord;
      if (type === "succeeded") {
        record = {
          custom_id: customId,
          result: { message: succeededMessage, type },
        };
      } else if (type === "errored") {
        record = {
          custom_id: customId,
          result: { error: read(result, "error"), type },
        };
      } else {
        record = { custom_id: customId, result: { type } };
      }
      resultCounts[type]++;
      const childIds = spanIds.children.get(customId);
      if (!childIds) {
        firstIssue ??= new Error("Anthropic Batch child span ID is missing");
        continue;
      }
      if (resumesStartedTrace) {
        await completeBatchResult(
          context,
          taskParent,
          endTime,
          input,
          record,
          childIds,
          state,
        );
      } else {
        await completeCollectOnlyBatchResult(
          context,
          taskParent,
          endTime,
          input,
          record,
          childIds,
          state,
        );
      }
      completedResults++;
      if (
        completedResults % BATCH_SPAN_CHUNK_SIZE === 0 &&
        consumedResults < total
      ) {
        await state.bgLogger().flush();
      }
    }
  } catch (error) {
    if (error instanceof BatchResultsSourceError) {
      resultsSourceError = error;
      firstIssue ??= new Error("Anthropic Batch results could not be consumed");
    } else {
      logBatchInstrumentationError("could not consume batch results", error);
      firstIssue ??= new Error("Anthropic Batch results could not be consumed");
    }
  }
  if (
    counts.processing !== 0 ||
    RESULT_TYPES.some((type) => resultCounts[type] !== counts[type])
  ) {
    firstIssue ??= new Error(
      "Anthropic Batch results do not match request counts",
    );
  }
  const terminalStatusError =
    counts.canceled > 0 || counts.expired > 0
      ? new Error(
          `Anthropic Batch completed with ${counts.canceled} canceled and ${counts.expired} expired requests`,
        )
      : undefined;
  if (firstIssue || seen.size !== inputData.inputs.size) {
    logBatchInstrumentationError(
      terminalStatusError
        ? "completed terminal batch with inconsistent results"
        : "left batch spans pending",
      firstIssue ?? new Error("Anthropic Batch results are incomplete"),
    );
  }
  if (terminalStatusError) {
    try {
      const unresolvedCount = inputData.inputs.size - seen.size;
      let processed = 0;
      for (const input of inputData.inputs.values()) {
        if (seen.has(input.customId)) {
          continue;
        }
        try {
          const childIds = spanIds.children.get(input.customId);
          if (!childIds) {
            throw new Error("Anthropic Batch child span ID is missing");
          }
          if (resumesStartedTrace) {
            const { span: child } = await startBatchChild(
              context,
              taskParent,
              input,
              childIds,
              state,
              true,
            );
            child.log({
              [MERGE_PATHS_FIELD]: [["metadata"], ["metrics"]],
              error: terminalStatusError,
              metadata: extractAnthropicInputMetadata(input.requestParams),
              metrics: { start: context.startTime },
              output: null,
            });
            child.end({ endTime });
          } else {
            await failCollectOnlyBatchChild(
              context,
              taskParent,
              endTime,
              input,
              terminalStatusError,
              childIds,
              state,
            );
          }
        } catch (error) {
          logBatchInstrumentationError(
            "could not fail unresolved batch child span",
            error,
          );
        }
        processed++;
        if (
          processed % BATCH_SPAN_CHUNK_SIZE === 0 &&
          processed < unresolvedCount
        ) {
          await state.bgLogger().flush();
        }
      }
      task.log({ error: terminalStatusError });
      task.end({ endTime });
    } finally {
      if (resumesStartedTrace) {
        pendingBatchTraces.delete(batchId);
      }
      if (resultsSourceError) {
        throw resultsSourceError;
      }
    }
    return;
  }
  if (resultsSourceError) {
    throw resultsSourceError;
  }
  if (firstIssue || seen.size !== inputData.inputs.size) {
    return;
  }
  task.log({ error: null });
  task.end({ endTime });
  if (resumesStartedTrace) {
    pendingBatchTraces.delete(batchId);
  }
}

export const interceptAnthropicBatchesCompleteTrace: Parameters<
  typeof anthropicChannels.batchesCompleteTrace.intercept
>[0] = (target, thisArg, args) =>
  Promise.resolve(Reflect.apply(target, thisArg, args)).then(async (result) => {
    try {
      await completeBatch(args[0]);
    } catch (error) {
      if (error instanceof BatchResultsSourceError) {
        throw error.sourceError;
      }
      logBatchInstrumentationError("could not complete batch", error);
    }
    return result;
  });
