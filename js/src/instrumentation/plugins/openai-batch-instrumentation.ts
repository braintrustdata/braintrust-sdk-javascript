import { debugLogger } from "../../debug-logger";
import {
  _internalGetGlobalState,
  _internalStartSpanWithInitialMerge,
  _internalStartSpanWithInitialMergeAndParentSpanIds,
  getSpanParentObject,
  NOOP_SPAN,
  type Span,
  withCurrent,
} from "../../logger";
import { parseMetricsFromUsage } from "../../openai-utils";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import {
  SpanComponentsV4,
  type SpanComponentsV4Data,
} from "../../../util/span_identifier_v4";
import type {
  CompleteOpenAIBatchTraceArgs,
  OpenAIBatchCreateParams,
  OpenAIBatchJSONL,
  OpenAIBatchLike,
  StartOpenAIBatchTraceArgs,
} from "../../openai-batch-types";
import { BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY } from "./openai-batch-constants";
import { openAIChannels } from "./openai-channels";
import {
  extractOpenAIBatchInput,
  processImagesInOutput,
} from "./openai-span-data";

const SUPPORTED_ENDPOINTS = new Set(["/v1/chat/completions", "/v1/responses"]);
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);
const INPUT_DIGEST_CHUNK_SIZE = 1024 * 1024;

type BatchContext = {
  version: 1;
  parent: string;
  inputFileId: string;
  inputDigest: string;
  endpoint: string;
  startTime: number;
  operationNonce: string;
};

type SerializedBatchContext = Omit<BatchContext, "endpoint" | "inputFileId"> & {
  signature: string;
};

type BatchResultRecord = {
  value: Record<string, unknown>;
  source: "output" | "error";
};

type BatchInputRecord = {
  customId: string;
  spanData?: ReturnType<typeof extractOpenAIBatchInput>;
};

type OpenAIBatchFile =
  CompleteOpenAIBatchTraceArgs<OpenAIBatchLike>["outputFile"];

type PreparedBatch = {
  context: BatchContext;
  inputs: Map<string, BatchInputRecord>;
  params: OpenAIBatchCreateParams;
};

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

function isBatchRecordIterable(
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

function validCustomId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function logBatchInstrumentationError(context: string, error: unknown): void {
  debugLogger.debug(`OpenAI Batch instrumentation ${context}:`, error);
}

function batchContextPayload(context: BatchContext): string {
  return JSON.stringify([BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY, context]);
}

async function importBatchSigningKey(secret: string) {
  return await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signBatchContext(
  context: BatchContext,
  secret: string,
): Promise<string | undefined> {
  try {
    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      await importBatchSigningKey(secret),
      new TextEncoder().encode(batchContextPayload(context)),
    );
    return digestHex(new Uint8Array(signature), 32);
  } catch {
    return undefined;
  }
}

function signatureBytes(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return undefined;
  }
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

async function verifyBatchContext(
  context: BatchContext,
  signature: string,
): Promise<boolean> {
  const secret =
    _internalGetGlobalState()._internalGetTraceContextSigningSecret();
  if (!secret) {
    return false;
  }
  const bytes = signatureBytes(signature);
  if (!bytes) {
    return false;
  }
  try {
    return await globalThis.crypto.subtle.verify(
      "HMAC",
      await importBatchSigningKey(secret),
      bytes,
      new TextEncoder().encode(batchContextPayload(context)),
    );
  } catch {
    return false;
  }
}

async function parseBatchContext(
  value: unknown,
  inputFileId: string,
  endpoint: string,
): Promise<BatchContext | undefined> {
  if (typeof value !== "string") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isObject(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.parent !== "string" ||
    typeof parsed.inputDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.inputDigest) ||
    typeof parsed.startTime !== "number" ||
    !Number.isFinite(parsed.startTime) ||
    typeof parsed.operationNonce !== "string" ||
    !/^[0-9a-f]{32}$/.test(parsed.operationNonce) ||
    typeof parsed.signature !== "string"
  ) {
    return undefined;
  }

  const context: BatchContext = {
    version: 1,
    parent: parsed.parent,
    inputFileId,
    inputDigest: parsed.inputDigest,
    endpoint,
    startTime: parsed.startTime,
    operationNonce: parsed.operationNonce,
  };
  if (!(await verifyBatchContext(context, parsed.signature))) {
    return undefined;
  }

  try {
    SpanComponentsV4.fromStr(context.parent);
  } catch {
    return undefined;
  }
  return context;
}

async function exportParent(parent: ReturnType<typeof getSpanParentObject>) {
  if ("toStr" in parent && typeof parent.toStr === "function") {
    return parent.toStr();
  }
  return await parent.export();
}

async function exportMinimalParent(
  parent: ReturnType<typeof getSpanParentObject>,
): Promise<string | undefined> {
  const exported = await exportParent(parent);
  if (!exported) {
    return undefined;
  }
  const parsed = SpanComponentsV4.fromStr(exported).data;
  const projectId = read(parsed.compute_object_metadata_args, "project_id");
  const projectName = read(parsed.compute_object_metadata_args, "project_name");
  const computeObjectMetadataArgs =
    typeof projectId === "string" || typeof projectName === "string"
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
  // SpanComponents requires all three span identifiers together. The
  // conditional below preserves that invariant, but TypeScript cannot infer
  // it through the object spreads.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return new SpanComponentsV4({
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
}

async function prepareCreateParams(
  args: StartOpenAIBatchTraceArgs,
  parent: ReturnType<typeof getSpanParentObject>,
  startTime: number,
): Promise<PreparedBatch | undefined> {
  const params: OpenAIBatchCreateParams = {
    ...args.params,
    input_file_id: args.inputFile.id,
  };
  const endpoint = read(params, "endpoint");
  const inputFileId = read(params, "input_file_id");
  if (
    typeof endpoint !== "string" ||
    !SUPPORTED_ENDPOINTS.has(endpoint) ||
    typeof inputFileId !== "string" ||
    inputFileId.length === 0
  ) {
    return undefined;
  }

  const metadataValue = read(params, "metadata");
  if (
    metadataValue !== undefined &&
    metadataValue !== null &&
    (!isObject(metadataValue) || Array.isArray(metadataValue))
  ) {
    logBatchInstrumentationError(
      "skipped context injection",
      "invalid metadata",
    );
    return undefined;
  }
  const metadata = metadataValue ?? {};
  if (
    Object.prototype.hasOwnProperty.call(
      metadata,
      BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY,
    )
  ) {
    logBatchInstrumentationError(
      "skipped context injection",
      "conflicting reserved metadata",
    );
    return undefined;
  }
  if (Object.keys(metadata).length >= 16) {
    logBatchInstrumentationError(
      "skipped context injection",
      "metadata is full",
    );
    return undefined;
  }

  const exportedParent = await exportMinimalParent(parent);
  if (!exportedParent) {
    logBatchInstrumentationError(
      "skipped context injection",
      "no routable Braintrust parent",
    );
    return undefined;
  }
  const signingSecret =
    _internalGetGlobalState()._internalGetTraceContextSigningSecret();
  if (!signingSecret) {
    logBatchInstrumentationError(
      "skipped context injection",
      "no signing secret is available",
    );
    return undefined;
  }
  const inputData = await readBatchInputs(args.input, endpoint);
  if (inputData.issues.length > 0) {
    logBatchInstrumentationError(
      "skipped invalid input file",
      inputData.issues[0],
    );
    return undefined;
  }
  const context: BatchContext = {
    version: 1,
    parent: exportedParent,
    inputFileId,
    inputDigest: inputData.inputDigest,
    endpoint,
    startTime,
    operationNonce: randomBatchNonce(),
  };
  const signature = await signBatchContext(context, signingSecret);
  if (!signature) {
    logBatchInstrumentationError(
      "skipped context injection",
      "could not sign batch context",
    );
    return undefined;
  }
  const serialized = JSON.stringify({
    version: context.version,
    parent: context.parent,
    inputDigest: context.inputDigest,
    startTime: context.startTime,
    operationNonce: context.operationNonce,
    signature,
  } satisfies SerializedBatchContext);
  if (serialized.length > 512) {
    logBatchInstrumentationError(
      "skipped context injection",
      "signed context exceeds OpenAI metadata limits",
    );
    return undefined;
  }

  return {
    context,
    inputs: inputData.inputs,
    params: {
      ...params,
      metadata: {
        ...metadata,
        [BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY]: serialized,
      },
    },
  };
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

function randomBatchNonce(): string {
  return digestHex(globalThis.crypto.getRandomValues(new Uint8Array(16)), 16);
}

async function batchSpanIds(operationNonce: string): Promise<{
  rowId: string;
  spanId: string;
  rootSpanId: string;
}> {
  const [row, span, root] = await Promise.all([
    deterministicDigest("openai:batch:row", operationNonce),
    deterministicDigest("openai:batch:span", operationNonce),
    deterministicDigest("openai:batch:root", operationNonce),
  ]);
  return {
    rowId: digestUuid(row),
    spanId: digestHex(span, 8),
    rootSpanId: digestHex(root, 16),
  };
}

async function childSpanIds(operationNonce: string, customId: string) {
  const [row, span] = await Promise.all([
    deterministicDigest("openai:batch:child:row", operationNonce, customId),
    deterministicDigest("openai:batch:child:span", operationNonce, customId),
  ]);
  return { rowId: digestUuid(row), spanId: digestHex(span, 8) };
}

async function batchContextFromBatch(
  batch: OpenAIBatchLike,
): Promise<BatchContext | undefined> {
  const metadata = read(batch, "metadata");
  const inputFileId = read(batch, "input_file_id");
  const endpoint = read(batch, "endpoint");
  if (
    !isObject(metadata) ||
    typeof inputFileId !== "string" ||
    typeof endpoint !== "string"
  ) {
    return undefined;
  }
  return await parseBatchContext(
    read(metadata, BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY),
    inputFileId,
    endpoint,
  );
}

async function startBatchSpan(context: BatchContext): Promise<Span> {
  const ids = await batchSpanIds(context.operationNonce);
  const parent = SpanComponentsV4.fromStr(context.parent);
  const hasParentSpan = Boolean(
    parent.data.row_id && parent.data.span_id && parent.data.root_span_id,
  );
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMergeAndParentSpanIds(
      withSpanInstrumentationName(
        {
          name: "openai.batch",
          type: SpanTypeAttribute.TASK,
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
          event: {
            id: ids.rowId,
            metadata: { provider: "openai" },
          },
        },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    ),
  );
}

async function startBatchChild(
  context: BatchContext,
  taskParent: string,
  input: BatchInputRecord,
): Promise<Span> {
  const ids = await childSpanIds(context.operationNonce, input.customId);
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMerge(
      withSpanInstrumentationName(
        {
          name:
            context.endpoint === "/v1/chat/completions"
              ? "Chat Completion"
              : "openai.responses.create",
          type: SpanTypeAttribute.LLM,
          parent: taskParent,
          spanId: ids.spanId,
          startTime: context.startTime,
          event: {
            id: ids.rowId,
            ...(input.spanData?.input !== undefined
              ? { input: input.spanData.input }
              : {}),
            metadata: {
              ...input.spanData?.metadata,
              provider: "openai",
            },
          },
        },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    ),
  );
}

async function* jsonlRecords(
  file: OpenAIBatchJSONL | OpenAIBatchFile,
  onIssue: (error: Error) => void = () => {},
): AsyncGenerator<unknown> {
  const resolvedFile = await file;
  if (resolvedFile === undefined) {
    return;
  }
  if (typeof resolvedFile === "string") {
    let offset = 0;
    while (offset < resolvedFile.length) {
      const newline = resolvedFile.indexOf("\n", offset);
      const end = newline === -1 ? resolvedFile.length : newline;
      const line = resolvedFile.slice(offset, end).replace(/\r$/, "");
      offset = newline === -1 ? resolvedFile.length : newline + 1;
      if (!line.trim()) {
        continue;
      }
      try {
        yield JSON.parse(line);
      } catch (error) {
        logBatchInstrumentationError("skipped malformed JSONL", error);
        onIssue(new Error("OpenAI Batch file contains malformed JSONL"));
      }
    }
    return;
  }

  const body = read(resolvedFile, "body");
  const getReader = read(body, "getReader");
  if (isObject(body) && typeof getReader === "function") {
    let reader: unknown;
    try {
      reader = Reflect.apply(getReader, body, []);
      if (!isObject(reader)) {
        throw new Error("Response body returned an invalid stream reader");
      }

      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const readChunk = read(reader, "read");
        if (typeof readChunk !== "function") {
          throw new Error("Response body stream reader has no read method");
        }
        const chunk = await Reflect.apply(readChunk, reader, []);
        if (!isObject(chunk)) {
          throw new Error("Response body stream returned an invalid chunk");
        }
        if (chunk.done === true) {
          pending += decoder.decode();
          break;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("Response body stream returned a non-byte chunk");
        }

        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/, "");
          pending = pending.slice(newline + 1);
          if (line.trim()) {
            try {
              yield JSON.parse(line);
            } catch (error) {
              logBatchInstrumentationError("skipped malformed JSONL", error);
              onIssue(
                new Error("OpenAI Batch response contains malformed JSONL"),
              );
            }
          }
          newline = pending.indexOf("\n");
        }
      }

      if (pending.trim()) {
        try {
          yield JSON.parse(pending.replace(/\r$/, ""));
        } catch (error) {
          logBatchInstrumentationError("skipped malformed JSONL", error);
          onIssue(new Error("OpenAI Batch response contains malformed JSONL"));
        }
      }
    } catch (error) {
      logBatchInstrumentationError("could not read JSONL response body", error);
      onIssue(new Error("OpenAI Batch response body could not be read"));
    } finally {
      const releaseLock = read(reader, "releaseLock");
      if (isObject(reader) && typeof releaseLock === "function") {
        try {
          Reflect.apply(releaseLock, reader, []);
        } catch (error) {
          logBatchInstrumentationError(
            "could not release stream reader",
            error,
          );
        }
      }
    }
    return;
  }

  if (isBatchRecordIterable(resolvedFile)) {
    for await (const record of resolvedFile) {
      yield record;
    }
  } else {
    logBatchInstrumentationError("skipped invalid JSONL source", resolvedFile);
    onIssue(new Error("OpenAI Batch file source is invalid"));
  }
}

async function startPreparedBatch(
  inputs: Map<string, BatchInputRecord>,
  context: BatchContext,
): Promise<void> {
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  for (const input of inputs.values()) {
    try {
      await startBatchChild(context, taskParent, input);
    } catch (error) {
      logBatchInstrumentationError("skipped invalid input record", error);
    }
  }
}

export const interceptOpenAIBatchTraceStart: Parameters<
  typeof openAIChannels.batchesStartTrace.intercept
>[0] = async (target, thisArg, args) => {
  const parent = getSpanParentObject();
  const startTime = getCurrentUnixTimestamp();
  let prepared: PreparedBatch | undefined;
  try {
    prepared = await prepareCreateParams(args[0], parent, startTime);
  } catch (error) {
    logBatchInstrumentationError("could not prepare batch", error);
  }

  const params = await Reflect.apply(target, thisArg, [
    prepared
      ? {
          ...args[0],
          params: prepared.params,
        }
      : args[0],
  ]);
  if (prepared) {
    try {
      await startPreparedBatch(prepared.inputs, prepared.context);
    } catch (error) {
      logBatchInstrumentationError("could not start batch spans", error);
    }
  }
  return params;
};

function errorFromResult(result: BatchResultRecord): Error | undefined {
  const error = read(result.value, "error");
  if (isObject(error)) {
    const message = read(error, "message");
    return new Error(
      typeof message === "string" ? message : "OpenAI Batch request failed",
    );
  }
  const response = read(result.value, "response");
  const statusCode = read(response, "status_code");
  if (
    result.source === "error" ||
    (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300))
  ) {
    const body = read(response, "body");
    const bodyError = read(body, "error");
    const message = read(bodyError, "message");
    return new Error(
      typeof message === "string" ? message : "OpenAI Batch request failed",
    );
  }
  return undefined;
}

async function completeBatchResult(
  context: BatchContext,
  taskParent: string,
  endTime: number,
  input: BatchInputRecord,
  result: BatchResultRecord,
): Promise<void> {
  const child = await startBatchChild(context, taskParent, input);
  try {
    const resultError = errorFromResult(result);
    const response = read(result.value, "response");
    const responseBody = read(response, "body");
    if (resultError) {
      child.log({ error: resultError });
    } else if (isObject(responseBody)) {
      if (context.endpoint === "/v1/chat/completions") {
        const model = read(responseBody, "model");
        child.log({
          output: read(responseBody, "choices"),
          ...(typeof model === "string" ? { metadata: { model } } : {}),
          metrics: parseMetricsFromUsage(read(responseBody, "usage")),
        });
      } else {
        const model = read(responseBody, "model");
        child.log({
          output: processImagesInOutput(read(responseBody, "output")),
          ...(typeof model === "string" ? { metadata: { model } } : {}),
          metrics: parseMetricsFromUsage(read(responseBody, "usage")),
        });
      }
    } else {
      child.log({ error: new Error("OpenAI Batch response body is missing") });
    }
  } catch (error) {
    child.log({ error });
  } finally {
    child.end({ endTime });
  }
}

async function readBatchInputs(
  file: OpenAIBatchFile,
  endpoint: string,
): Promise<{
  inputDigest: string;
  inputs: Map<string, BatchInputRecord>;
  issues: Error[];
}> {
  const inputs = new Map<string, BatchInputRecord>();
  const issues: Error[] = [];
  const chunkDigests: string[] = [];
  let digestChunk = "";
  try {
    for await (const value of jsonlRecords(file, (issue) =>
      issues.push(issue),
    )) {
      const customId = read(value, "custom_id");
      const body = read(value, "body");
      if (
        !validCustomId(customId) ||
        inputs.has(customId) ||
        read(value, "method") !== "POST" ||
        read(value, "url") !== endpoint ||
        !isObject(body)
      ) {
        issues.push(new Error("OpenAI Batch input contains an invalid record"));
        continue;
      }
      const canonicalRecord = JSON.stringify({
        body: canonicalizeJSON(body),
        custom_id: customId,
      });
      const framedRecord = `${canonicalRecord.length}:${canonicalRecord}`;
      if (
        digestChunk.length > 0 &&
        digestChunk.length + framedRecord.length > INPUT_DIGEST_CHUNK_SIZE
      ) {
        chunkDigests.push(
          digestHex(
            await deterministicDigest("openai:batch:input:chunk", digestChunk),
            32,
          ),
        );
        digestChunk = "";
      }
      digestChunk += framedRecord;

      let spanData: BatchInputRecord["spanData"];
      try {
        spanData = extractOpenAIBatchInput(endpoint, body);
      } catch (error) {
        logBatchInstrumentationError("could not extract batch input", error);
      }
      inputs.set(customId, { customId, spanData });
    }
  } catch (error) {
    logBatchInstrumentationError("could not process input file", error);
    issues.push(new Error("OpenAI Batch input file could not be processed"));
  }
  chunkDigests.push(
    digestHex(
      await deterministicDigest("openai:batch:input:chunk", digestChunk),
      32,
    ),
  );
  return {
    inputDigest: digestHex(
      await deterministicDigest("openai:batch:input", chunkDigests.join("")),
      32,
    ),
    inputs,
    issues,
  };
}

function canonicalizeJSON(
  value: unknown,
  ancestors: Set<object> = new Set(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("OpenAI Batch input contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error("OpenAI Batch input contains a circular value");
    }
    ancestors.add(value);
    try {
      return value.map((entry) => canonicalizeJSON(entry, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isObject(value)) {
    throw new Error("OpenAI Batch input contains a non-JSON value");
  }
  if (ancestors.has(value)) {
    throw new Error("OpenAI Batch input contains a circular value");
  }
  ancestors.add(value);
  try {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          const entry = read(value, key);
          if (entry === undefined) {
            throw new Error("OpenAI Batch input contains an undefined value");
          }
          return [key, canonicalizeJSON(entry, ancestors)];
        }),
    );
  } finally {
    ancestors.delete(value);
  }
}

async function completeResultFile({
  context,
  endTime,
  file,
  inputs,
  issues,
  seen,
  source,
  taskParent,
}: {
  context: BatchContext;
  endTime: number;
  file: OpenAIBatchFile;
  inputs: Map<string, BatchInputRecord>;
  issues: Error[];
  seen: Set<string>;
  source: BatchResultRecord["source"];
  taskParent: string;
}): Promise<void> {
  try {
    for await (const value of jsonlRecords(file, (issue) =>
      issues.push(issue),
    )) {
      try {
        const customId = read(value, "custom_id");
        if (!validCustomId(customId) || !isObject(value)) {
          logBatchInstrumentationError(
            "skipped result without custom_id",
            value,
          );
          issues.push(
            new Error("OpenAI Batch result is missing a valid custom_id"),
          );
          continue;
        }
        if (seen.has(customId)) {
          logBatchInstrumentationError("skipped duplicate result", customId);
          issues.push(new Error("OpenAI Batch result contains a duplicate"));
          continue;
        }
        const input = inputs.get(customId);
        if (!input) {
          issues.push(
            new Error("OpenAI Batch result does not match an input record"),
          );
          continue;
        }
        seen.add(customId);
        await completeBatchResult(context, taskParent, endTime, input, {
          value,
          source,
        });
      } catch (error) {
        logBatchInstrumentationError("skipped invalid result", error);
        issues.push(new Error("OpenAI Batch result could not be processed"));
      }
    }
  } catch (error) {
    logBatchInstrumentationError(`could not process ${source} file`, error);
    issues.push(
      new Error(`OpenAI Batch ${source} file could not be processed`),
    );
  }
}

function terminalEndTime(
  batch: OpenAIBatchLike,
  webhookCreatedAt: number | undefined,
  startTime: number,
): number {
  let timestamp: number | null | undefined;
  switch (batch.status) {
    case "completed":
      timestamp = batch.completed_at;
      break;
    case "failed":
      timestamp = batch.failed_at;
      break;
    case "expired":
      timestamp = batch.expired_at;
      break;
    default:
      timestamp = batch.cancelled_at;
  }

  if (
    typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp >= startTime
  ) {
    return timestamp;
  }
  if (
    typeof webhookCreatedAt === "number" &&
    Number.isFinite(webhookCreatedAt) &&
    webhookCreatedAt >= startTime
  ) {
    return webhookCreatedAt;
  }
  return Math.max(getCurrentUnixTimestamp(), startTime);
}

async function completeBatch(
  args: CompleteOpenAIBatchTraceArgs<OpenAIBatchLike>,
): Promise<void> {
  const { batch, webhook } = args;
  const batchId = read(batch, "id");
  const status = read(batch, "status");
  if (
    typeof batchId !== "string" ||
    typeof status !== "string" ||
    !TERMINAL_STATUSES.has(status)
  ) {
    return;
  }
  if (
    webhook &&
    (read(webhook, "type") !== `batch.${status}` ||
      read(read(webhook, "data"), "id") !== batchId)
  ) {
    logBatchInstrumentationError("ignored mismatched webhook", webhook);
    return;
  }
  const context = await batchContextFromBatch(batch);
  if (!context || !SUPPORTED_ENDPOINTS.has(context.endpoint)) {
    return;
  }

  const endTime = terminalEndTime(
    batch,
    webhook?.created_at,
    context.startTime,
  );
  const inputData = await readBatchInputs(args.inputFile, context.endpoint);
  const issues = [...inputData.issues];
  if (
    inputData.issues.length === 0 &&
    inputData.inputDigest !== context.inputDigest
  ) {
    issues.push(
      new Error("OpenAI Batch input does not match the signed input file"),
    );
  }
  const requestTotal = read(read(batch, "request_counts"), "total");
  if (
    typeof requestTotal === "number" &&
    requestTotal !== inputData.inputs.size
  ) {
    issues.push(
      new Error("OpenAI Batch input does not match its request count"),
    );
  }
  if (issues.length > 0) {
    logBatchInstrumentationError("left batch spans pending", issues[0]);
    return;
  }

  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  const seen = new Set<string>();
  await Promise.all([
    completeResultFile({
      context,
      endTime,
      file: args.outputFile,
      inputs: inputData.inputs,
      issues,
      seen,
      source: "output",
      taskParent,
    }),
    completeResultFile({
      context,
      endTime,
      file: args.errorFile,
      inputs: inputData.inputs,
      issues,
      seen,
      source: "error",
      taskParent,
    }),
  ]);
  if (issues.length > 0) {
    logBatchInstrumentationError("left batch spans pending", issues[0]);
    return;
  }

  const missing = [...inputData.inputs.values()].filter(
    ({ customId }) => !seen.has(customId),
  );
  if (status === "completed" && missing.length > 0) {
    logBatchInstrumentationError(
      "left batch spans pending",
      new Error("OpenAI Batch result files are incomplete"),
    );
    return;
  }
  for (const input of missing) {
    try {
      const child = await startBatchChild(context, taskParent, input);
      child.log({ error: new Error(`OpenAI Batch ${status}`) });
      child.end({ endTime });
    } catch (error) {
      logBatchInstrumentationError("could not complete missing result", error);
    }
  }

  if (status !== "completed") {
    task.log({ error: new Error(`OpenAI Batch ${status}`) });
  }
  task.end({ endTime });
}

export const interceptOpenAIBatchTraceComplete: Parameters<
  typeof openAIChannels.batchesCompleteTrace.intercept
>[0] = (target, thisArg, args) =>
  Promise.resolve(Reflect.apply(target, thisArg, args)).then(async (batch) => {
    try {
      await completeBatch({ ...args[0], batch });
    } catch (error) {
      logBatchInstrumentationError("could not complete batch", error);
    }
    return batch;
  });
