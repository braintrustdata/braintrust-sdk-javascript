import { debugLogger } from "../../debug-logger";
import {
  _internalGetGlobalState,
  _internalStartSpanWithInitialMerge,
  _internalStartSpanWithInitialMergeAndParentSpanIds,
  flush,
  getSpanParentObject,
  NOOP_SPAN,
  type Span,
  utf8ByteLength,
  withCurrent,
} from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import { isObject, SpanTypeAttribute } from "../../../util/index";
import {
  SpanComponentsV4,
  type SpanComponentsV4Data,
} from "../../../util/span_identifier_v4";
import type {
  BindGroqBatchTraceArgs,
  CollectGroqBatchTraceArgs,
  FailGroqBatchTraceArgs,
  GroqBatchCreateParams,
  GroqBatchJSONL,
  GroqBatchLike,
  GroqBatchReplayableJSONL,
  GroqBatchTraceContext,
  StartGroqBatchTraceArgs,
} from "../../groq-batch-types";
import { groqChannels } from "./groq-channels";
import { extractGroqCompletionInput, parseGroqMetrics } from "./groq-span-data";

const BRAINTRUST_GROQ_BATCH_CONTEXT_KEY = "braintrust.batch_context";
const BRAINTRUST_GROQ_BATCH_BINDING_KEY = "braintrust.batch_binding";
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);
const INPUT_DIGEST_CHUNK_SIZE = 1024 * 1024;
const MAX_CONTEXT_LENGTH = 512;
const MAX_BATCH_INPUT_RECORDS = 50_000;
const MAX_BATCH_FILE_BYTES = 100 * 1024 * 1024;
const MAX_STAGED_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_STAGED_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_RECORD_BYTES = MAX_BATCH_FILE_BYTES;
const MAX_BATCH_SPANS_BETWEEN_FLUSHES = 1000;

type BatchContext = {
  version: 1;
  parent: string;
  inputFileId: string;
  inputDigest: string;
  endpoint: "/v1/chat/completions";
  startTime: number;
  operationNonce: string;
  repairInputs: boolean;
};

type SerializedBatchContext = Omit<BatchContext, "endpoint" | "inputFileId"> & {
  signature: string;
};

type BatchBinding = {
  version: 1;
  batchId: string;
  operationNonce: string;
};

type SerializedBatchBinding = BatchBinding & {
  signature: string;
};

type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

type ParsedBatchRecord = {
  value: JSONValue;
  serialized: string;
  encodedBytes: number;
};

type BatchInputRecord = {
  customId: string;
  spanData?: ReturnType<typeof extractGroqCompletionInput>;
};

type BatchResultRecord = {
  customId: string;
  error?: Error;
  outcome: "completed" | "failed";
  responseBody?: Record<string, unknown>;
};

type BatchFile =
  | GroqBatchJSONL
  | CollectGroqBatchTraceArgs<GroqBatchLike>["outputFile"];

type PreparedBatch = {
  context: BatchContext;
  input: GroqBatchReplayableJSONL;
  inputData: BatchInputData;
  params: GroqBatchCreateParams;
};

type BatchInputData = {
  inputCount: number;
  inputDigest: string;
  inputs?: Map<string, BatchInputRecord>;
  issues: Error[];
  remaining: Set<string>;
};

type BatchResultCounts = {
  completed: number;
  failed: number;
};

type StagedBatchResult = {
  input: BatchInputRecord;
  result: BatchResultRecord;
};

type BatchFlushState = {
  spansSinceFlush: number;
};

type BatchFileDigestState = {
  chunk: string;
  chunkBytes: number;
  chunkDigests: string[];
};

class BatchFatalError extends Error {}
class BatchRecordLimitError extends BatchFatalError {}
class BatchEmissionError extends Error {}

function batchReplayIssue(
  replay: BatchInputData,
  expected: BatchInputData,
  changedInputMessage: string,
): Error | undefined {
  const inputIssue = replay.issues[0];
  if (inputIssue instanceof BatchFatalError) {
    return inputIssue;
  }
  if (
    replay.inputCount !== expected.inputCount ||
    replay.inputDigest !== expected.inputDigest
  ) {
    return new Error(changedInputMessage);
  }
  return undefined;
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

function replayableBatchInput(input: GroqBatchReplayableJSONL): GroqBatchJSONL {
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "function") {
    const source = input();
    if (isBatchRecordIterable(source)) {
      return source;
    }
  }
  throw new Error(
    "Groq Batch start and failure input must be a string or replayable iterable factory",
  );
}

function validCustomId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function logBatchInstrumentationError(context: string, error: unknown): void {
  debugLogger.debug(`Groq Batch instrumentation ${context}:`, error);
}

function recordBatchIssue(issues: Error[], error: Error): void {
  if (
    issues.length === 0 ||
    (error instanceof BatchFatalError &&
      !(issues[0] instanceof BatchFatalError))
  ) {
    issues[0] = error;
  }
}

async function applyBatchWriteBackpressure(
  state: BatchFlushState,
): Promise<void> {
  state.spansSinceFlush += 1;
  if (state.spansSinceFlush >= MAX_BATCH_SPANS_BETWEEN_FLUSHES) {
    await flush();
    state.spansSinceFlush = 0;
  }
}

function batchContextPayload(context: BatchContext): string {
  return JSON.stringify(["groq", BRAINTRUST_GROQ_BATCH_CONTEXT_KEY, context]);
}

function batchBindingPayload(binding: BatchBinding): string {
  return JSON.stringify(["groq", BRAINTRUST_GROQ_BATCH_BINDING_KEY, binding]);
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

async function signedBatchContextValue(
  context: BatchContext,
  secret: string,
): Promise<string | undefined> {
  const signature = await signBatchContext(context, secret);
  if (!signature) {
    return undefined;
  }
  const serialized = JSON.stringify({
    version: context.version,
    parent: context.parent,
    inputDigest: context.inputDigest,
    startTime: context.startTime,
    operationNonce: context.operationNonce,
    repairInputs: context.repairInputs,
    signature,
  } satisfies SerializedBatchContext);
  return serialized.length <= MAX_CONTEXT_LENGTH ? serialized : undefined;
}

async function signBatchBinding(
  binding: BatchBinding,
  secret: string,
): Promise<string | undefined> {
  try {
    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      await importBatchSigningKey(secret),
      new TextEncoder().encode(batchBindingPayload(binding)),
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
  const bytes = signatureBytes(signature);
  if (!secret || !bytes) {
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

async function verifyBatchBinding(
  binding: BatchBinding,
  signature: string,
): Promise<boolean> {
  const secret =
    _internalGetGlobalState()._internalGetTraceContextSigningSecret();
  const bytes = signatureBytes(signature);
  if (!secret || !bytes) {
    return false;
  }
  try {
    return await globalThis.crypto.subtle.verify(
      "HMAC",
      await importBatchSigningKey(secret),
      bytes,
      new TextEncoder().encode(batchBindingPayload(binding)),
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
  if (
    typeof value !== "string" ||
    endpoint !== "/v1/chat/completions" ||
    value.length > MAX_CONTEXT_LENGTH
  ) {
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
    typeof parsed.repairInputs !== "boolean" ||
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
    repairInputs: parsed.repairInputs,
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
  let computeObjectMetadataArgs:
    | { project_id?: string; project_name?: string }
    | undefined;
  if (typeof projectId === "string" || typeof projectName === "string") {
    computeObjectMetadataArgs = {};
    if (typeof projectId === "string") {
      computeObjectMetadataArgs.project_id = projectId;
    }
    if (typeof projectName === "string") {
      computeObjectMetadataArgs.project_name = projectName;
    }
  }
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
  args: StartGroqBatchTraceArgs,
  parent: ReturnType<typeof getSpanParentObject>,
  startTime: number,
): Promise<PreparedBatch | undefined> {
  const params: GroqBatchCreateParams = {
    ...args.params,
    input_file_id: args.inputFile.id,
  };
  const endpoint = read(params, "endpoint");
  const inputFileId = read(params, "input_file_id");
  if (
    endpoint !== "/v1/chat/completions" ||
    typeof inputFileId !== "string" ||
    inputFileId.length === 0
  ) {
    return undefined;
  }

  const metadataValue = read(params, "metadata");
  if (
    metadataValue !== undefined &&
    metadataValue !== null &&
    !isObject(metadataValue)
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
      BRAINTRUST_GROQ_BATCH_CONTEXT_KEY,
    )
  ) {
    logBatchInstrumentationError(
      "skipped context injection",
      "conflicting reserved metadata",
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

  const inputData = await scanBatchInputs(replayableBatchInput(args.input));
  const inputIssue = inputData.issues[0];
  if (inputIssue instanceof BatchFatalError) {
    logBatchInstrumentationError("skipped invalid input file", inputIssue);
    return undefined;
  }
  if (inputIssue) {
    logBatchInstrumentationError(
      "skipped invalid input records while preparing valid requests",
      inputIssue,
    );
  }
  const context: BatchContext = {
    version: 1,
    parent: exportedParent,
    inputFileId,
    inputDigest: inputData.inputDigest,
    endpoint,
    startTime,
    operationNonce: randomBatchNonce(),
    repairInputs: false,
  };
  const serialized = await signedBatchContextValue(context, signingSecret);
  if (!serialized) {
    logBatchInstrumentationError(
      "skipped context injection",
      "could not serialize signed batch context",
    );
    return undefined;
  }

  return {
    context,
    input: args.input,
    inputData,
    params: {
      ...params,
      metadata: {
        ...metadata,
        [BRAINTRUST_GROQ_BATCH_CONTEXT_KEY]: serialized,
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

async function addBatchFileDigestRecord(
  state: BatchFileDigestState,
  source: "output" | "error",
  record: ParsedBatchRecord,
): Promise<void> {
  const { serialized, encodedBytes: serializedBytes } = record;
  const framed = `${source.length}:${source}${serializedBytes}:${serialized}`;
  const framedBytes =
    String(source.length).length +
    1 +
    source.length +
    String(serializedBytes).length +
    1 +
    serializedBytes;
  if (
    state.chunkBytes > 0 &&
    state.chunkBytes + framedBytes > INPUT_DIGEST_CHUNK_SIZE
  ) {
    state.chunkDigests.push(
      digestHex(
        await deterministicDigest("groq:batch:result:chunk", state.chunk),
        32,
      ),
    );
    state.chunk = "";
    state.chunkBytes = 0;
  }
  state.chunk += framed;
  state.chunkBytes += framedBytes;
}

async function finishBatchFileDigest(
  state: BatchFileDigestState,
): Promise<string> {
  state.chunkDigests.push(
    digestHex(
      await deterministicDigest("groq:batch:result:chunk", state.chunk),
      32,
    ),
  );
  return digestHex(
    await deterministicDigest("groq:batch:result", state.chunkDigests.join("")),
    32,
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
    deterministicDigest("groq:batch:row", operationNonce),
    deterministicDigest("groq:batch:span", operationNonce),
    deterministicDigest("groq:batch:root", operationNonce),
  ]);
  return {
    rowId: digestUuid(row),
    spanId: digestHex(span, 8),
    rootSpanId: digestHex(root, 16),
  };
}

async function childSpanIds(operationNonce: string, customId: string) {
  const [row, span] = await Promise.all([
    deterministicDigest("groq:batch:child:row", operationNonce, customId),
    deterministicDigest("groq:batch:child:span", operationNonce, customId),
  ]);
  return { rowId: digestUuid(row), spanId: digestHex(span, 8) };
}

async function unboundBatchContextFromValues(
  value: GroqBatchLike | GroqBatchCreateParams,
): Promise<BatchContext | undefined> {
  const metadata = read(value, "metadata");
  const inputFileId = read(value, "input_file_id");
  const endpoint = read(value, "endpoint");
  if (
    !isObject(metadata) ||
    typeof inputFileId !== "string" ||
    typeof endpoint !== "string"
  ) {
    return undefined;
  }
  return await parseBatchContext(
    read(metadata, BRAINTRUST_GROQ_BATCH_CONTEXT_KEY),
    inputFileId,
    endpoint,
  );
}

async function bindBatchTrace(
  args: BindGroqBatchTraceArgs<GroqBatchLike>,
): Promise<GroqBatchTraceContext | undefined> {
  const context = await unboundBatchContextFromValues(args.batch);
  const batchId = read(args.batch, "id");
  const signingSecret =
    _internalGetGlobalState()._internalGetTraceContextSigningSecret();
  if (!context || !validCustomId(batchId) || !signingSecret) {
    logBatchInstrumentationError(
      "could not bind provider batch ID",
      new Error(
        "Groq Batch start context, batch ID, or signing key is invalid",
      ),
    );
    return undefined;
  }

  const binding: BatchBinding = {
    version: 1,
    batchId,
    operationNonce: context.operationNonce,
  };
  const signature = await signBatchBinding(binding, signingSecret);
  if (!signature) {
    logBatchInstrumentationError(
      "could not bind provider batch ID",
      new Error("Groq Batch binding could not be signed"),
    );
    return undefined;
  }
  const value = JSON.stringify({
    ...binding,
    signature,
  } satisfies SerializedBatchBinding);
  if (value.length > MAX_CONTEXT_LENGTH) {
    logBatchInstrumentationError(
      "could not bind provider batch ID",
      new Error("Groq Batch binding exceeds the instrumentation limit"),
    );
    return undefined;
  }
  return { value };
}

async function validateBatchTraceBinding(
  batch: GroqBatchLike,
  context: BatchContext,
  traceContext: GroqBatchTraceContext | undefined,
): Promise<boolean> {
  const value = read(traceContext, "value");
  const batchId = read(batch, "id");
  if (
    typeof value !== "string" ||
    value.length > MAX_CONTEXT_LENGTH ||
    !validCustomId(batchId)
  ) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (
    !isObject(parsed) ||
    parsed.version !== 1 ||
    parsed.batchId !== batchId ||
    parsed.operationNonce !== context.operationNonce ||
    typeof parsed.signature !== "string"
  ) {
    return false;
  }
  return await verifyBatchBinding(
    {
      version: 1,
      batchId,
      operationNonce: context.operationNonce,
    },
    parsed.signature,
  );
}

export const interceptGroqBatchTraceBind: Parameters<
  typeof groqChannels.batchesBindTrace.intercept
>[0] = async (target, thisArg, args) => {
  await Reflect.apply(target, thisArg, args);
  try {
    const traceContext = await bindBatchTrace(args[0]);
    return traceContext ? { traceContext } : {};
  } catch (error) {
    logBatchInstrumentationError("could not bind provider batch ID", error);
    return {};
  }
};

async function startBatchSpan(context: BatchContext): Promise<Span> {
  const ids = await batchSpanIds(context.operationNonce);
  const parent = SpanComponentsV4.fromStr(context.parent);
  const parentSpanIds =
    parent.data.span_id && parent.data.root_span_id
      ? {
          parentSpanIds: [parent.data.span_id],
          rootSpanId: parent.data.root_span_id,
        }
      : {
          parentSpanIds: [],
          rootSpanId: ids.rootSpanId,
        };
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMergeAndParentSpanIds(
      withSpanInstrumentationName(
        {
          name: "groq.batch",
          type: SpanTypeAttribute.TASK,
          parent: context.parent,
          parentSpanIds,
          spanId: ids.spanId,
          startTime: context.startTime,
          event: {
            id: ids.rowId,
            metadata: { provider: "groq" },
          },
        },
        INSTRUMENTATION_NAMES.GROQ,
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
          name: "groq.chat.completions.create",
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
              provider: "groq",
            },
          },
        },
        INSTRUMENTATION_NAMES.GROQ,
      ),
    ),
  );
}

async function* jsonlRecords(
  file: BatchFile,
  onIssue: (error: Error) => void = () => {},
): AsyncGenerator<ParsedBatchRecord> {
  let resolvedFile = await file;
  if (typeof resolvedFile === "function") {
    resolvedFile = await resolvedFile();
  }
  if (resolvedFile === undefined) {
    return;
  }
  if (typeof resolvedFile === "string") {
    if (utf8ByteLength(resolvedFile) > MAX_BATCH_FILE_BYTES) {
      onIssue(new BatchFatalError("Groq Batch file exceeds the 100 MB limit"));
      return;
    }
    let offset = 0;
    while (offset < resolvedFile.length) {
      const newline = resolvedFile.indexOf("\n", offset);
      const end = newline === -1 ? resolvedFile.length : newline;
      const line = resolvedFile.slice(offset, end).replace(/\r$/, "");
      offset = newline === -1 ? resolvedFile.length : newline + 1;
      if (!line.trim()) {
        continue;
      }
      const lineBytes = utf8ByteLength(line);
      if (lineBytes > MAX_BATCH_RECORD_BYTES) {
        onIssue(new BatchRecordLimitError("Groq Batch record exceeds 100 MB"));
        return;
      }
      try {
        yield canonicalBatchRecord(JSON.parse(line));
      } catch (error) {
        logBatchInstrumentationError("skipped malformed JSONL", error);
        onIssue(
          error instanceof BatchFatalError
            ? error
            : new Error("Groq Batch file contains malformed JSONL"),
        );
      }
    }
    return;
  }

  const body = read(resolvedFile, "body");
  const getReader = read(body, "getReader");
  if (isObject(body) && typeof getReader === "function") {
    let reader: unknown;
    let fullyConsumed = false;
    try {
      reader = Reflect.apply(getReader, body, []);
      if (!isObject(reader)) {
        throw new Error("Response body returned an invalid stream reader");
      }
      const decoder = new TextDecoder();
      let encodedBytes = 0;
      let pending = "";
      let pendingLineBytes = 0;
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
          fullyConsumed = true;
          break;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("Response body stream returned a non-byte chunk");
        }
        encodedBytes += chunk.value.byteLength;
        if (encodedBytes > MAX_BATCH_FILE_BYTES) {
          onIssue(
            new BatchFatalError("Groq Batch response exceeds the 100 MB limit"),
          );
          return;
        }
        for (const byte of chunk.value) {
          if (byte === 0x0a) {
            pendingLineBytes = 0;
          } else {
            pendingLineBytes += 1;
            if (pendingLineBytes > MAX_BATCH_RECORD_BYTES) {
              onIssue(
                new BatchRecordLimitError(
                  "Groq Batch response record exceeds 100 MB",
                ),
              );
              return;
            }
          }
        }
        const decoded = decoder.decode(chunk.value, { stream: true });
        pending += decoded;
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/, "");
          pending = pending.slice(newline + 1);
          if (line.trim()) {
            try {
              yield canonicalBatchRecord(JSON.parse(line));
            } catch (error) {
              logBatchInstrumentationError("skipped malformed JSONL", error);
              onIssue(
                error instanceof BatchFatalError
                  ? error
                  : new Error("Groq Batch response contains malformed JSONL"),
              );
            }
          }
          newline = pending.indexOf("\n");
        }
      }
      if (pending.trim()) {
        try {
          yield canonicalBatchRecord(JSON.parse(pending.replace(/\r$/, "")));
        } catch (error) {
          logBatchInstrumentationError("skipped malformed JSONL", error);
          onIssue(
            error instanceof BatchFatalError
              ? error
              : new Error("Groq Batch response contains malformed JSONL"),
          );
        }
      }
    } catch (error) {
      logBatchInstrumentationError("could not read JSONL response body", error);
      onIssue(
        new BatchFatalError("Groq Batch response body could not be read"),
      );
    } finally {
      const cancel = read(reader, "cancel");
      if (!fullyConsumed && isObject(reader) && typeof cancel === "function") {
        try {
          await Reflect.apply(cancel, reader, []);
        } catch (error) {
          logBatchInstrumentationError(
            "could not cancel partially consumed response body",
            error,
          );
        }
      }
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
    let encodedBytes = 0;
    let recordCount = 0;
    for await (const record of resolvedFile) {
      let normalizedRecord: ParsedBatchRecord;
      try {
        normalizedRecord = normalizeIterableBatchRecord(record);
      } catch (error) {
        logBatchInstrumentationError(
          "could not measure iterable JSONL record",
          error,
        );
        onIssue(
          error instanceof BatchRecordLimitError
            ? error
            : new Error("Groq Batch iterable contains a non-JSON record"),
        );
        if (error instanceof BatchRecordLimitError) {
          return;
        }
        continue;
      }
      encodedBytes += normalizedRecord.encodedBytes + (recordCount > 0 ? 1 : 0);
      recordCount += 1;
      if (encodedBytes > MAX_BATCH_FILE_BYTES) {
        onIssue(
          new BatchFatalError("Groq Batch iterable exceeds the 100 MB limit"),
        );
        return;
      }
      yield normalizedRecord;
    }
  } else {
    logBatchInstrumentationError(
      "skipped invalid JSONL source",
      new Error("Groq Batch file source has an unsupported type"),
    );
    onIssue(new BatchFatalError("Groq Batch file source is invalid"));
  }
}

async function closePartiallyStartedBatch(
  context: BatchContext,
  task: Span,
  taskParent: string,
  attemptedCustomIds: Set<string>,
  error: Error,
): Promise<boolean> {
  const endTime = Math.max(getCurrentUnixTimestamp(), context.startTime);
  const flushState: BatchFlushState = { spansSinceFlush: 0 };
  let childEmissionFailed = false;
  for (const customId of attemptedCustomIds) {
    try {
      const child = await startBatchChild(context, taskParent, { customId });
      child.log({ error });
      child.end({ endTime });
      await applyBatchWriteBackpressure(flushState);
    } catch (closeError) {
      childEmissionFailed = true;
      logBatchInstrumentationError(
        "could not close partially started batch child",
        closeError,
      );
    }
  }
  if (childEmissionFailed) {
    await flush();
    return false;
  }
  try {
    task.log({ error });
    task.end({ endTime });
    await flush();
    return true;
  } catch (closeError) {
    logBatchInstrumentationError(
      "could not close partially started batch task",
      closeError,
    );
    await flush();
    return false;
  }
}

async function startPreparedBatch(prepared: PreparedBatch): Promise<boolean> {
  const { context, input, inputData } = prepared;
  const validationData = await scanBatchInputs(replayableBatchInput(input));
  const validationInputIssue = validationData.issues[0];
  if (
    validationInputIssue &&
    !(validationInputIssue instanceof BatchFatalError)
  ) {
    logBatchInstrumentationError(
      "skipped invalid replay records while validating valid requests",
      validationInputIssue,
    );
  }
  const validationIssue = batchReplayIssue(
    validationData,
    inputData,
    "Groq Batch replayable input changed between passes",
  );
  if (validationIssue) {
    logBatchInstrumentationError(
      "withheld correlation context before starting batch spans",
      validationIssue,
    );
    return false;
  }

  await flush();
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  await flush();
  const flushState: BatchFlushState = { spansSinceFlush: 0 };
  const attemptedCustomIds = new Set<string>();
  let emissionFailed = false;
  const replayData = await scanBatchInputs(replayableBatchInput(input), {
    onInput: async (record) => {
      if (emissionFailed) {
        return;
      }
      attemptedCustomIds.add(record.customId);
      try {
        await startBatchChild(context, taskParent, record);
        await applyBatchWriteBackpressure(flushState);
      } catch (error) {
        emissionFailed = true;
        logBatchInstrumentationError("could not start batch child", error);
      }
    },
  });
  const replayInputIssue = replayData.issues[0];
  if (replayInputIssue && !(replayInputIssue instanceof BatchFatalError)) {
    logBatchInstrumentationError(
      "skipped invalid input records while starting valid requests",
      replayInputIssue,
    );
  }
  const replayIssue = batchReplayIssue(
    replayData,
    inputData,
    "Groq Batch replayable input changed between passes",
  );
  if (replayIssue || emissionFailed) {
    const startError =
      replayIssue ??
      new BatchEmissionError("Groq Batch child span emission was incomplete");
    logBatchInstrumentationError(
      "could not fully start batch spans",
      startError,
    );
    if (
      await closePartiallyStartedBatch(
        context,
        task,
        taskParent,
        attemptedCustomIds,
        startError,
      )
    ) {
      return false;
    }
    logBatchInstrumentationError(
      "preserved correlation context for partially started batch repair",
      startError,
    );
    const signingSecret =
      _internalGetGlobalState()._internalGetTraceContextSigningSecret();
    const repairContext = { ...context, repairInputs: true };
    const repairValue = signingSecret
      ? await signedBatchContextValue(repairContext, signingSecret)
      : undefined;
    if (repairValue) {
      prepared.context = repairContext;
      prepared.params = {
        ...prepared.params,
        metadata: {
          ...prepared.params.metadata,
          [BRAINTRUST_GROQ_BATCH_CONTEXT_KEY]: repairValue,
        },
      };
    } else {
      logBatchInstrumentationError(
        "could not mark partial batch context for input repair",
        new Error("Groq Batch repair context could not be signed"),
      );
    }
    return true;
  }
  await flush();
  return true;
}

export const interceptGroqBatchTraceStart: Parameters<
  typeof groqChannels.batchesStartTrace.intercept
>[0] = async (target, thisArg, args) => {
  const parent = getSpanParentObject();
  const startTime = getCurrentUnixTimestamp();
  let prepared: PreparedBatch | undefined;
  try {
    prepared = await prepareCreateParams(args[0], parent, startTime);
  } catch (error) {
    logBatchInstrumentationError("could not prepare batch", error);
  }

  let started = false;
  if (prepared) {
    try {
      started = await startPreparedBatch(prepared);
    } catch (error) {
      logBatchInstrumentationError("could not start batch spans", error);
    }
  }
  return await Reflect.apply(target, thisArg, [
    prepared && started ? { ...args[0], params: prepared.params } : args[0],
  ]);
};

function serializedJSONStringBytes(value: string, maxBytes?: number): number {
  let bytes = 2;
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new BatchRecordLimitError(
      "Groq Batch record exceeds the 100 MB limit",
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (maxBytes !== undefined && bytes > maxBytes) {
      throw new BatchRecordLimitError(
        "Groq Batch record exceeds the 100 MB limit",
      );
    }
  }
  return bytes;
}

function canonicalizeJSON(value: unknown, maxBytes?: number): JSONValue {
  const byteBudget = { used: 0, max: maxBytes };
  const ancestors = new Set<object>();

  function consumeBytes(serialized: string): void {
    byteBudget.used += utf8ByteLength(serialized);
    if (byteBudget.max !== undefined && byteBudget.used > byteBudget.max) {
      throw new BatchRecordLimitError(
        "Groq Batch record exceeds the 100 MB limit",
      );
    }
  }

  function consumeJSONStringBytes(stringValue: string): void {
    const remaining =
      byteBudget.max === undefined
        ? undefined
        : byteBudget.max - byteBudget.used;
    byteBudget.used += serializedJSONStringBytes(stringValue, remaining);
  }

  function visit(entry: unknown): JSONValue {
    if (entry === null) {
      consumeBytes("null");
      return entry;
    }
    if (typeof entry === "string" || typeof entry === "boolean") {
      if (typeof entry === "string") {
        consumeJSONStringBytes(entry);
      } else {
        consumeBytes(JSON.stringify(entry));
      }
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new Error("Groq Batch input contains a non-finite number");
      }
      consumeBytes(JSON.stringify(entry));
      return entry;
    }
    if (Array.isArray(entry)) {
      if (ancestors.has(entry)) {
        throw new Error("Groq Batch input contains a circular value");
      }
      ancestors.add(entry);
      consumeBytes("[]");
      try {
        const result: JSONValue[] = [];
        for (let index = 0; index < entry.length; index += 1) {
          if (index > 0) {
            consumeBytes(",");
          }
          result.push(visit(entry[index]));
        }
        return result;
      } finally {
        ancestors.delete(entry);
      }
    }
    if (!isObject(entry)) {
      throw new Error("Groq Batch input contains a non-JSON value");
    }
    if (ancestors.has(entry)) {
      throw new Error("Groq Batch input contains a circular value");
    }
    ancestors.add(entry);
    consumeBytes("{}");
    try {
      const result: Array<[string, JSONValue]> = [];
      const keys = Object.keys(entry).sort();
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const item = read(entry, key);
        if (item === undefined) {
          throw new Error("Groq Batch input contains an undefined value");
        }
        if (index > 0) {
          consumeBytes(",");
        }
        consumeJSONStringBytes(key);
        consumeBytes(":");
        result.push([key, visit(item)]);
      }
      return Object.fromEntries(result);
    } finally {
      ancestors.delete(entry);
    }
  }

  return visit(value);
}

function canonicalBatchRecord(
  value: unknown,
  maxBytes = MAX_BATCH_RECORD_BYTES,
): ParsedBatchRecord {
  const canonicalValue = canonicalizeJSON(value, maxBytes);
  const serialized = JSON.stringify(canonicalValue);
  if (serialized === undefined) {
    throw new Error("Groq Batch record could not be serialized");
  }
  return {
    value: canonicalValue,
    serialized,
    encodedBytes: utf8ByteLength(serialized),
  };
}

function normalizeIterableBatchRecord(value: unknown): ParsedBatchRecord {
  let estimatedBytes = 0;
  const serialized = JSON.stringify(value, function (key, entry) {
    const arrayEntry = Array.isArray(this);
    const omitted =
      !arrayEntry &&
      key !== "" &&
      (entry === undefined ||
        typeof entry === "function" ||
        typeof entry === "symbol");
    if (omitted) {
      return entry;
    }

    if (key !== "") {
      estimatedBytes += 1;
      if (!arrayEntry) {
        estimatedBytes +=
          serializedJSONStringBytes(
            key,
            MAX_BATCH_RECORD_BYTES - estimatedBytes,
          ) + 1;
      }
    }
    if (
      entry === undefined ||
      typeof entry === "function" ||
      typeof entry === "symbol" ||
      (typeof entry === "number" && !Number.isFinite(entry))
    ) {
      estimatedBytes += 4;
    } else if (typeof entry === "string") {
      estimatedBytes += serializedJSONStringBytes(
        entry,
        MAX_BATCH_RECORD_BYTES - estimatedBytes,
      );
    } else if (entry === null) {
      estimatedBytes += 4;
    } else if (typeof entry === "boolean") {
      estimatedBytes += entry ? 4 : 5;
    } else if (typeof entry === "number") {
      estimatedBytes += String(entry).length;
    } else if (typeof entry === "object") {
      estimatedBytes += 2;
    }
    if (estimatedBytes > MAX_BATCH_RECORD_BYTES) {
      throw new BatchRecordLimitError(
        "Groq Batch record exceeds the 100 MB limit",
      );
    }
    return entry;
  });
  if (typeof serialized !== "string") {
    throw new Error("Groq Batch iterable contains a non-JSON record");
  }
  const standardBytes = utf8ByteLength(serialized);
  if (standardBytes > MAX_BATCH_RECORD_BYTES) {
    throw new BatchRecordLimitError(
      "Groq Batch record exceeds the 100 MB limit",
    );
  }
  return canonicalBatchRecord(JSON.parse(serialized));
}

async function scanBatchInputs(
  file: BatchFile,
  options: {
    retainInputs?: boolean;
    allowUnstagedInputs?: boolean;
    onInput?: (input: BatchInputRecord) => Promise<void>;
  } = {},
): Promise<BatchInputData> {
  let inputs = options.retainInputs
    ? new Map<string, BatchInputRecord>()
    : undefined;
  const issues: Error[] = [];
  const chunkDigests: string[] = [];
  const remaining = new Set<string>();
  let bufferedInputBytes = 0;
  let digestChunk = "";
  let digestChunkBytes = 0;
  let totalCanonicalBytes = 0;
  try {
    for await (const record of jsonlRecords(file, (issue) =>
      recordBatchIssue(issues, issue),
    )) {
      const value = record.value;
      const customId = read(value, "custom_id");
      const body = read(value, "body");
      if (
        !validCustomId(customId) ||
        remaining.has(customId) ||
        read(value, "method") !== "POST" ||
        read(value, "url") !== "/v1/chat/completions" ||
        !isObject(body)
      ) {
        recordBatchIssue(
          issues,
          new Error("Groq Batch input contains an invalid record"),
        );
        continue;
      }
      if (remaining.size >= MAX_BATCH_INPUT_RECORDS) {
        recordBatchIssue(
          issues,
          new BatchFatalError(
            `Groq Batch input exceeds the ${MAX_BATCH_INPUT_RECORDS} record limit`,
          ),
        );
        break;
      }

      let canonicalRecord: ParsedBatchRecord;
      try {
        canonicalRecord = canonicalBatchRecord({
          body: canonicalizeJSON(body),
          custom_id: customId,
        });
      } catch (error) {
        logBatchInstrumentationError("skipped invalid input record", error);
        recordBatchIssue(
          issues,
          new Error("Groq Batch input contains a non-JSON record"),
        );
        continue;
      }
      const canonicalRecordBytes = canonicalRecord.encodedBytes;
      if (
        inputs &&
        bufferedInputBytes + canonicalRecordBytes > MAX_STAGED_INPUT_BYTES
      ) {
        inputs.clear();
        inputs = undefined;
        if (!options.allowUnstagedInputs) {
          recordBatchIssue(
            issues,
            new BatchFatalError(
              "Groq Batch staged input exceeds the 16 MiB buffer",
            ),
          );
          break;
        }
      }
      totalCanonicalBytes += canonicalRecordBytes;
      if (totalCanonicalBytes > MAX_BATCH_FILE_BYTES) {
        recordBatchIssue(
          issues,
          new BatchFatalError("Groq Batch input exceeds the 100 MB limit"),
        );
        break;
      }
      const framedRecord = `${canonicalRecordBytes}:${canonicalRecord.serialized}`;
      const framedRecordBytes =
        String(canonicalRecordBytes).length + 1 + canonicalRecordBytes;
      if (
        digestChunkBytes > 0 &&
        digestChunkBytes + framedRecordBytes > INPUT_DIGEST_CHUNK_SIZE
      ) {
        chunkDigests.push(
          digestHex(
            await deterministicDigest("groq:batch:input:chunk", digestChunk),
            32,
          ),
        );
        digestChunk = "";
        digestChunkBytes = 0;
      }
      digestChunk += framedRecord;
      digestChunkBytes += framedRecordBytes;
      remaining.add(customId);

      let spanData: BatchInputRecord["spanData"];
      if (inputs || options.onInput) {
        try {
          spanData = extractGroqCompletionInput(body);
        } catch (error) {
          logBatchInstrumentationError("could not extract batch input", error);
        }
      }
      const input = { customId, spanData };
      if (inputs) {
        bufferedInputBytes += canonicalRecordBytes;
        inputs.set(customId, input);
      }
      await options.onInput?.(input);
    }
  } catch (error) {
    logBatchInstrumentationError("could not process input file", error);
    recordBatchIssue(
      issues,
      new BatchFatalError("Groq Batch input file could not be processed"),
    );
  }
  chunkDigests.push(
    digestHex(
      await deterministicDigest("groq:batch:input:chunk", digestChunk),
      32,
    ),
  );
  return {
    inputCount: remaining.size,
    inputDigest: digestHex(
      await deterministicDigest("groq:batch:input", chunkDigests.join("")),
      32,
    ),
    inputs,
    issues,
    remaining,
  };
}

function batchResultError(value: unknown): Error | undefined {
  if (typeof value === "string" && value.length > 0) {
    return new Error(value);
  }
  if (!isObject(value)) {
    return undefined;
  }
  const message = read(value, "message");
  return new Error(
    typeof message === "string" && message.length > 0
      ? message
      : "Groq Batch request failed",
  );
}

function validateBatchResult(
  value: unknown,
  source: "output" | "error",
): BatchResultRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const customId = read(value, "custom_id");
  if (!validCustomId(customId)) {
    return undefined;
  }

  const response = read(value, "response");
  const statusCode = read(response, "status_code");
  const responseBody = read(response, "body");
  const topLevelError = batchResultError(read(value, "error"));
  if (source === "output") {
    if (
      !isObject(response) ||
      typeof statusCode !== "number" ||
      !Number.isInteger(statusCode) ||
      statusCode < 200 ||
      statusCode >= 300 ||
      !isObject(responseBody) ||
      !Array.isArray(read(responseBody, "choices")) ||
      topLevelError
    ) {
      return undefined;
    }
    return {
      customId,
      outcome: "completed",
      responseBody,
    };
  }

  const responseError = batchResultError(read(responseBody, "error"));
  const hasFailedStatus =
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    (statusCode < 200 || statusCode >= 300);
  if (!topLevelError && !responseError && !hasFailedStatus) {
    return undefined;
  }
  return {
    customId,
    error:
      topLevelError ?? responseError ?? new Error("Groq Batch request failed"),
    outcome: "failed",
  };
}

async function completeBatchResult(
  context: BatchContext,
  taskParent: string,
  endTime: number,
  input: BatchInputRecord,
  result: BatchResultRecord,
): Promise<void> {
  const child = await startBatchChild(context, taskParent, input);
  if (result.error) {
    child.log({ error: result.error });
  } else if (result.responseBody) {
    const model = read(result.responseBody, "model");
    child.log({
      output: read(result.responseBody, "choices"),
      ...(typeof model === "string" ? { metadata: { model } } : {}),
      metrics: parseGroqMetrics(result.responseBody),
    });
  }
  child.end({ endTime });
}

async function completeResultFile({
  context,
  endTime,
  file,
  inputData,
  issues,
  resultCounts,
  seen,
  source,
  taskParent,
  flushState,
  digestState,
}: {
  context: BatchContext;
  endTime: number;
  file: BatchFile;
  inputData: BatchInputData;
  issues: Error[];
  resultCounts: BatchResultCounts;
  seen: Set<string>;
  source: "output" | "error";
  taskParent: string;
  flushState: BatchFlushState;
  digestState?: BatchFileDigestState;
}): Promise<boolean> {
  let resultRecordCount = 0;
  let emissionSucceeded = true;
  try {
    for await (const record of jsonlRecords(file, (issue) =>
      recordBatchIssue(issues, issue),
    )) {
      const value = record.value;
      try {
        resultRecordCount += 1;
        if (resultRecordCount > MAX_BATCH_INPUT_RECORDS) {
          recordBatchIssue(
            issues,
            new Error(
              `Groq Batch result exceeds the ${MAX_BATCH_INPUT_RECORDS} record limit`,
            ),
          );
          break;
        }
        if (digestState) {
          await addBatchFileDigestRecord(digestState, source, record);
        }
        const result = validateBatchResult(value, source);
        if (!result) {
          recordBatchIssue(
            issues,
            new Error("Groq Batch result contains an invalid record"),
          );
          continue;
        }
        if (seen.has(result.customId)) {
          recordBatchIssue(
            issues,
            new Error("Groq Batch result contains a duplicate"),
          );
          continue;
        }
        if (!inputData.remaining.has(result.customId)) {
          recordBatchIssue(
            issues,
            new Error("Groq Batch result does not match an input record"),
          );
          continue;
        }
        const input = inputData.inputs?.get(result.customId) ?? {
          customId: result.customId,
        };
        await completeBatchResult(context, taskParent, endTime, input, result);
        await applyBatchWriteBackpressure(flushState);
        seen.add(result.customId);
        inputData.remaining.delete(result.customId);
        resultCounts[result.outcome] += 1;
      } catch (error) {
        emissionSucceeded = false;
        logBatchInstrumentationError("skipped invalid result", error);
        recordBatchIssue(
          issues,
          new BatchEmissionError(
            "Groq Batch child span emission was incomplete",
          ),
        );
      }
    }
  } catch (error) {
    logBatchInstrumentationError(`could not process ${source} file`, error);
    recordBatchIssue(
      issues,
      new Error(`Groq Batch ${source} file could not be processed`),
    );
  }
  return emissionSucceeded;
}

async function stageResultFile({
  file,
  inputData,
  issues,
  resultCounts,
  seen,
  source,
  stagedBytes,
  stagedResults,
  digestState,
}: {
  file: BatchFile;
  inputData: BatchInputData;
  issues: Error[];
  resultCounts: BatchResultCounts;
  seen: Set<string>;
  source: "output" | "error";
  stagedBytes?: { value: number };
  stagedResults?: Map<string, StagedBatchResult>;
  digestState?: BatchFileDigestState;
}): Promise<boolean> {
  let resultRecordCount = 0;
  try {
    for await (const record of jsonlRecords(file, (issue) =>
      recordBatchIssue(issues, issue),
    )) {
      const value = record.value;
      resultRecordCount += 1;
      if (resultRecordCount > MAX_BATCH_INPUT_RECORDS) {
        recordBatchIssue(
          issues,
          new Error(
            `Groq Batch result exceeds the ${MAX_BATCH_INPUT_RECORDS} record limit`,
          ),
        );
        return false;
      }

      if (digestState) {
        await addBatchFileDigestRecord(digestState, source, record);
      }

      const result = validateBatchResult(value, source);
      if (!result) {
        recordBatchIssue(
          issues,
          new Error("Groq Batch result contains an invalid record"),
        );
        continue;
      }
      if (seen.has(result.customId)) {
        recordBatchIssue(
          issues,
          new Error("Groq Batch result contains a duplicate"),
        );
        continue;
      }
      if (!inputData.remaining.has(result.customId)) {
        recordBatchIssue(
          issues,
          new Error("Groq Batch result does not match an input record"),
        );
        continue;
      }
      const input = inputData.inputs?.get(result.customId) ?? {
        customId: result.customId,
      };
      if (stagedBytes) {
        stagedBytes.value += record.encodedBytes;
      }
      if (stagedBytes && stagedBytes.value > MAX_STAGED_RESULT_BYTES) {
        recordBatchIssue(
          issues,
          new Error("Groq Batch staged results exceed the 16 MiB buffer"),
        );
        return false;
      }

      seen.add(result.customId);
      inputData.remaining.delete(result.customId);
      resultCounts[result.outcome] += 1;
      stagedResults?.set(result.customId, { input, result });
    }
  } catch (error) {
    logBatchInstrumentationError(`could not stage ${source} file`, error);
    recordBatchIssue(
      issues,
      new Error(`Groq Batch ${source} file could not be staged`),
    );
  }
  return true;
}

function terminalEndTime(batch: GroqBatchLike, startTime: number): number {
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
  return typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp >= startTime
    ? timestamp
    : Math.max(getCurrentUnixTimestamp(), startTime);
}

async function validatedBatchInputs(
  file: BatchFile,
  context: BatchContext | undefined,
  retainInputs = false,
): Promise<BatchInputData> {
  const inputData = await scanBatchInputs(file, {
    retainInputs,
    allowUnstagedInputs: context?.repairInputs,
  });
  const issues = [...inputData.issues];
  const inputIssue = issues[0];
  if (
    context &&
    !(inputIssue instanceof BatchFatalError) &&
    inputData.inputDigest !== context.inputDigest
  ) {
    recordBatchIssue(
      issues,
      new BatchFatalError(
        "Groq Batch input does not match the signed input file",
      ),
    );
  }
  return { ...inputData, issues };
}

async function collectOnlyBatchContext(
  batch: GroqBatchLike,
  inputData: BatchInputData,
  parent: ReturnType<typeof getSpanParentObject>,
  collectionTime: number,
): Promise<BatchContext | undefined> {
  const exportedParent = await exportParent(parent);
  const batchId = read(batch, "id");
  const inputFileId = read(batch, "input_file_id");
  const endpoint = read(batch, "endpoint");
  if (
    !exportedParent ||
    typeof batchId !== "string" ||
    batchId.length === 0 ||
    typeof inputFileId !== "string" ||
    inputFileId.length === 0 ||
    endpoint !== "/v1/chat/completions"
  ) {
    return undefined;
  }
  const createdAt = read(batch, "created_at");
  const startTime =
    typeof createdAt === "number" &&
    Number.isFinite(createdAt) &&
    createdAt >= 0 &&
    createdAt <= collectionTime
      ? createdAt
      : collectionTime;
  return {
    version: 1,
    parent: exportedParent,
    inputFileId,
    inputDigest: inputData.inputDigest,
    endpoint,
    startTime,
    repairInputs: false,
    operationNonce: digestHex(
      await deterministicDigest(
        "groq:batch:collect-only",
        exportedParent,
        batchId,
        inputData.inputDigest,
      ),
      16,
    ),
  };
}

function validateBatchResultCounts(
  batch: GroqBatchLike,
  inputCount: number,
  actual: BatchResultCounts,
): Error[] {
  const requestCounts = read(batch, "request_counts");
  if (requestCounts === undefined || requestCounts === null) {
    return [];
  }
  if (!isObject(requestCounts)) {
    return [new Error("Groq Batch request counts are invalid")];
  }

  const issues: Error[] = [];
  for (const [key, expected, observed] of [
    ["total", read(requestCounts, "total"), inputCount],
    ["completed", read(requestCounts, "completed"), actual.completed],
    ["failed", read(requestCounts, "failed"), actual.failed],
  ] as const) {
    if (
      expected !== undefined &&
      (typeof expected !== "number" ||
        !Number.isInteger(expected) ||
        expected < 0 ||
        expected !== observed)
    ) {
      issues.push(new Error(`Groq Batch ${key} request count is inconsistent`));
    }
  }
  return issues;
}

function completedBatchResultSourcesIssue(
  args: CollectGroqBatchTraceArgs<GroqBatchLike>,
): Error | undefined {
  const requestCounts = read(args.batch, "request_counts");
  if (requestCounts === undefined || requestCounts === null) {
    return undefined;
  }
  if (!isObject(requestCounts)) {
    return new Error("Groq Batch request counts are invalid");
  }
  const completed = read(requestCounts, "completed");
  const failed = read(requestCounts, "failed");
  const total = read(requestCounts, "total");
  for (const [key, value] of [
    ["completed", completed],
    ["failed", failed],
    ["total", total],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    ) {
      return new Error(`Groq Batch ${key} request count is invalid`);
    }
  }

  const completedCount = typeof completed === "number" ? completed : undefined;
  const failedCount = typeof failed === "number" ? failed : undefined;
  const totalCount = typeof total === "number" ? total : undefined;
  if (totalCount === 0) {
    return undefined;
  }

  let requiresOutput = false;
  if (completedCount !== undefined) {
    requiresOutput = completedCount > 0;
  } else if (totalCount !== undefined && failedCount !== undefined) {
    requiresOutput = failedCount < totalCount;
  }

  let requiresError = false;
  if (failedCount !== undefined) {
    requiresError = failedCount > 0;
  } else if (totalCount !== undefined && completedCount !== undefined) {
    requiresError = completedCount < totalCount;
  }
  if (requiresOutput && args.outputFile === undefined) {
    return new Error(
      "Groq Batch completed collection requires the output file",
    );
  }
  if (requiresError && args.errorFile === undefined) {
    return new Error("Groq Batch completed collection requires the error file");
  }
  return undefined;
}

async function resultFilesAreReplayable(
  args: CollectGroqBatchTraceArgs<GroqBatchLike>,
): Promise<boolean> {
  for (const file of [args.outputFile, args.errorFile]) {
    if (file === undefined) {
      continue;
    }
    const resolved = await file;
    if (typeof resolved !== "string" && typeof resolved !== "function") {
      return false;
    }
  }
  return true;
}

async function completeReplayableSignedCompletedBatch(
  args: CollectGroqBatchTraceArgs<GroqBatchLike>,
  context: BatchContext,
  inputData: BatchInputData,
): Promise<void> {
  const validationInputData = {
    ...inputData,
    remaining: new Set(inputData.remaining),
  };
  const validationIssues: Error[] = [];
  const validationCounts: BatchResultCounts = { completed: 0, failed: 0 };
  const validationDigest: BatchFileDigestState = {
    chunk: "",
    chunkBytes: 0,
    chunkDigests: [],
  };
  const validationSeen = new Set<string>();
  const outputValid = await stageResultFile({
    file: args.outputFile,
    inputData: validationInputData,
    issues: validationIssues,
    resultCounts: validationCounts,
    seen: validationSeen,
    source: "output",
    digestState: validationDigest,
  });
  const errorValid = await stageResultFile({
    file: args.errorFile,
    inputData: validationInputData,
    issues: validationIssues,
    resultCounts: validationCounts,
    seen: validationSeen,
    source: "error",
    digestState: validationDigest,
  });
  const validationCountIssues = validateBatchResultCounts(
    args.batch,
    inputData.inputCount,
    validationCounts,
  );
  const validationIssue = validationIssues[0] ?? validationCountIssues[0];
  if (validationIssue instanceof BatchRecordLimitError) {
    logBatchInstrumentationError(
      "left completed batch spans pending after result record overflow",
      validationIssue,
    );
    return;
  }
  if (
    !outputValid ||
    !errorValid ||
    validationIssue ||
    validationInputData.remaining.size > 0
  ) {
    logBatchInstrumentationError(
      "left completed batch spans pending after replayable validation",
      validationIssue ?? new Error("Groq Batch result files are incomplete"),
    );
    return;
  }
  const expectedDigest = await finishBatchFileDigest(validationDigest);

  const endTime = terminalEndTime(args.batch, context.startTime);
  await flush();
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  await flush();
  const flushState: BatchFlushState = { spansSinceFlush: 0 };
  const emissionInputData = {
    ...inputData,
    remaining: new Set(inputData.remaining),
  };
  const emissionIssues: Error[] = [];
  const emissionCounts: BatchResultCounts = { completed: 0, failed: 0 };
  const emissionDigest: BatchFileDigestState = {
    chunk: "",
    chunkBytes: 0,
    chunkDigests: [],
  };
  const emissionSeen = new Set<string>();
  const outputEmissionSucceeded = await completeResultFile({
    context,
    endTime,
    file: args.outputFile,
    inputData: emissionInputData,
    issues: emissionIssues,
    resultCounts: emissionCounts,
    seen: emissionSeen,
    source: "output",
    taskParent,
    flushState,
    digestState: emissionDigest,
  });
  const errorEmissionSucceeded = await completeResultFile({
    context,
    endTime,
    file: args.errorFile,
    inputData: emissionInputData,
    issues: emissionIssues,
    resultCounts: emissionCounts,
    seen: emissionSeen,
    source: "error",
    taskParent,
    flushState,
    digestState: emissionDigest,
  });
  const observedDigest = await finishBatchFileDigest(emissionDigest);
  const emissionCountIssues = validateBatchResultCounts(
    args.batch,
    inputData.inputCount,
    emissionCounts,
  );
  const emissionIssue = emissionIssues[0] ?? emissionCountIssues[0];
  let collectionError: Error | undefined;
  if (!outputEmissionSucceeded || !errorEmissionSucceeded) {
    collectionError = new BatchEmissionError(
      "Groq Batch child span emission was incomplete",
    );
  } else if (emissionIssue) {
    collectionError = emissionIssue;
  } else if (observedDigest !== expectedDigest) {
    collectionError = new Error(
      "Groq Batch replayable result files changed between passes",
    );
  } else if (emissionInputData.remaining.size > 0) {
    collectionError = new Error(
      "Groq Batch replay left unresolved child spans",
    );
  }
  if (collectionError) {
    logBatchInstrumentationError(
      "left completed batch retryable after emission failure",
      collectionError,
    );
    await flush();
    return;
  }
  task.end({ endTime });
  await flush();
}

async function completeSignedCompletedBatch(
  args: CollectGroqBatchTraceArgs<GroqBatchLike>,
  context: BatchContext,
  inputData: BatchInputData,
): Promise<void> {
  if (await resultFilesAreReplayable(args)) {
    await completeReplayableSignedCompletedBatch(args, context, inputData);
    return;
  }

  const seen = new Set<string>();
  const issues: Error[] = [];
  const resultCounts: BatchResultCounts = { completed: 0, failed: 0 };
  const stagedBytes = { value: 0 };
  const stagedResults = new Map<string, StagedBatchResult>();
  const outputWithinBounds = await stageResultFile({
    file: args.outputFile,
    inputData,
    issues,
    resultCounts,
    seen,
    source: "output",
    stagedBytes,
    stagedResults,
  });
  const errorWithinBounds = await stageResultFile({
    file: args.errorFile,
    inputData,
    issues,
    resultCounts,
    seen,
    source: "error",
    stagedBytes,
    stagedResults,
  });
  const countIssues = validateBatchResultCounts(
    args.batch,
    inputData.inputCount,
    resultCounts,
  );
  const consistencyIssue = issues[0] ?? countIssues[0];
  if (!outputWithinBounds || !errorWithinBounds) {
    logBatchInstrumentationError(
      "left completed batch retryable after one-shot staging overflow",
      consistencyIssue ??
        new Error(
          "Groq Batch result files exceeded the 16 MiB one-shot collection buffer",
        ),
    );
    return;
  }
  if (consistencyIssue instanceof BatchRecordLimitError) {
    logBatchInstrumentationError(
      "left completed batch retryable after result record overflow",
      consistencyIssue,
    );
    return;
  }
  if (consistencyIssue || inputData.remaining.size > 0) {
    logBatchInstrumentationError(
      "left completed batch spans pending without emitting partial results",
      consistencyIssue ??
        new Error("Groq Batch result files are incomplete or exceed limits"),
    );
    return;
  }

  const endTime = terminalEndTime(args.batch, context.startTime);
  await flush();
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  await flush();
  const flushState: BatchFlushState = { spansSinceFlush: 0 };
  let emissionFailed = false;
  for (const staged of stagedResults.values()) {
    try {
      await completeBatchResult(
        context,
        taskParent,
        endTime,
        staged.input,
        staged.result,
      );
      await applyBatchWriteBackpressure(flushState);
    } catch (error) {
      emissionFailed = true;
      logBatchInstrumentationError("could not emit staged result", error);
    }
  }
  if (emissionFailed) {
    logBatchInstrumentationError(
      "left completed batch retryable after child emission failure",
      new Error("Groq Batch child span emission was incomplete"),
    );
    await flush();
    return;
  }
  task.end({ endTime });
  await flush();
}

async function completeSignedBatch(
  args: CollectGroqBatchTraceArgs<GroqBatchLike>,
  context: BatchContext,
  inputData: BatchInputData,
  status: string,
): Promise<void> {
  if (status === "completed") {
    await completeSignedCompletedBatch(args, context, inputData);
    return;
  }

  const endTime = terminalEndTime(args.batch, context.startTime);
  await flush();
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  await flush();
  const flushState: BatchFlushState = { spansSinceFlush: 0 };
  const seen = new Set<string>();
  const issues: Error[] = [];
  const resultCounts: BatchResultCounts = { completed: 0, failed: 0 };
  const outputEmissionSucceeded = await completeResultFile({
    context,
    endTime,
    file: args.outputFile,
    inputData,
    issues,
    resultCounts,
    seen,
    source: "output",
    taskParent,
    flushState,
  });
  const errorEmissionSucceeded = await completeResultFile({
    context,
    endTime,
    file: args.errorFile,
    inputData,
    issues,
    resultCounts,
    seen,
    source: "error",
    taskParent,
    flushState,
  });
  await flush();
  if (!outputEmissionSucceeded || !errorEmissionSucceeded) {
    logBatchInstrumentationError(
      `left ${status} batch retryable after child emission failure`,
      new BatchEmissionError("Groq Batch child span emission was incomplete"),
    );
    return;
  }
  const countIssues = validateBatchResultCounts(
    args.batch,
    inputData.inputCount,
    resultCounts,
  );
  const consistencyIssue = issues[0] ?? countIssues[0];
  if (consistencyIssue) {
    logBatchInstrumentationError(
      `completed ${status} batch with inconsistent results`,
      consistencyIssue,
    );
  }
  let unresolvedEmissionFailed = false;
  for (const customId of inputData.remaining) {
    try {
      const input = inputData.inputs?.get(customId) ?? { customId };
      const child = await startBatchChild(context, taskParent, input);
      child.log({ error: new Error(`Groq Batch ${status}`) });
      child.end({ endTime });
      await applyBatchWriteBackpressure(flushState);
    } catch (error) {
      unresolvedEmissionFailed = true;
      logBatchInstrumentationError("could not complete missing result", error);
    }
  }
  if (unresolvedEmissionFailed) {
    logBatchInstrumentationError(
      `left ${status} batch retryable after unresolved child emission failure`,
      new BatchEmissionError("Groq Batch child span emission was incomplete"),
    );
    await flush();
    return;
  }
  task.log({ error: new Error(`Groq Batch ${status}`) });
  task.end({ endTime });
  await flush();
}

async function completeCollectOnlyBatch(
  args: CollectGroqBatchTraceArgs<GroqBatchLike>,
  context: BatchContext,
  inputData: BatchInputData,
  status: string,
): Promise<void> {
  const seen = new Set<string>();
  const issues: Error[] = [];
  const resultCounts: BatchResultCounts = { completed: 0, failed: 0 };
  const stagedBytes = { value: 0 };
  const stagedResults = new Map<string, StagedBatchResult>();
  const outputWithinBounds = await stageResultFile({
    file: args.outputFile,
    inputData,
    issues,
    resultCounts,
    seen,
    source: "output",
    stagedBytes,
    stagedResults,
  });
  const errorWithinBounds = await stageResultFile({
    file: args.errorFile,
    inputData,
    issues,
    resultCounts,
    seen,
    source: "error",
    stagedBytes,
    stagedResults,
  });
  if (!outputWithinBounds || !errorWithinBounds) {
    logBatchInstrumentationError(
      "skipped collect-only tracing",
      issues[0] ?? new Error("Groq Batch results exceeded staging limits"),
    );
    return;
  }

  const countIssues = validateBatchResultCounts(
    args.batch,
    inputData.inputCount,
    resultCounts,
  );
  const consistencyIssue = issues[0] ?? countIssues[0];
  if (
    status === "completed" &&
    (consistencyIssue || inputData.remaining.size > 0)
  ) {
    logBatchInstrumentationError(
      "skipped inconsistent collect-only tracing",
      consistencyIssue ?? new Error("Groq Batch result files are incomplete"),
    );
    return;
  }
  if (consistencyIssue) {
    logBatchInstrumentationError(
      `completed collect-only ${status} batch with inconsistent results`,
      consistencyIssue,
    );
  }

  const endTime = terminalEndTime(args.batch, context.startTime);
  await flush();
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  await flush();
  const flushState: BatchFlushState = { spansSinceFlush: 0 };
  let emissionFailed = false;
  for (const input of inputData.inputs?.values() ?? []) {
    try {
      const staged = stagedResults.get(input.customId);
      if (staged) {
        await completeBatchResult(
          context,
          taskParent,
          endTime,
          staged.input,
          staged.result,
        );
      } else {
        const child = await startBatchChild(context, taskParent, input);
        child.log({ error: new Error(`Groq Batch ${status}`) });
        child.end({ endTime });
      }
      await applyBatchWriteBackpressure(flushState);
    } catch (error) {
      emissionFailed = true;
      logBatchInstrumentationError("could not emit collect-only child", error);
    }
  }
  if (emissionFailed) {
    logBatchInstrumentationError(
      `left collect-only ${status} batch retryable after child emission failure`,
      new BatchEmissionError("Groq Batch child span emission was incomplete"),
    );
    await flush();
    return;
  }
  if (status !== "completed") {
    task.log({ error: new Error(`Groq Batch ${status}`) });
  }
  task.end({ endTime });
  await flush();
}

async function repairSignedBatchInputs(
  file: BatchFile,
  context: BatchContext,
  expected: BatchInputData,
): Promise<boolean> {
  const validationData = await scanBatchInputs(file);
  const validationIssue = validationData.issues[0];
  if (
    validationIssue instanceof BatchFatalError ||
    validationData.inputCount !== expected.inputCount ||
    validationData.inputDigest !== expected.inputDigest
  ) {
    logBatchInstrumentationError(
      "left partial batch pending before input repair",
      validationIssue ??
        new Error("Groq Batch replayable repair input changed between passes"),
    );
    return false;
  }

  await flush();
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  await flush();
  const flushState: BatchFlushState = { spansSinceFlush: 0 };
  let emissionFailed = false;
  const emissionData = await scanBatchInputs(file, {
    onInput: async (input) => {
      if (emissionFailed) {
        return;
      }
      try {
        await startBatchChild(context, taskParent, input);
        await applyBatchWriteBackpressure(flushState);
      } catch (error) {
        emissionFailed = true;
        logBatchInstrumentationError(
          "could not repair partially started batch child input",
          error,
        );
      }
    },
  });
  const emissionIssue = emissionData.issues[0];
  if (
    emissionFailed ||
    emissionIssue instanceof BatchFatalError ||
    emissionData.inputCount !== expected.inputCount ||
    emissionData.inputDigest !== expected.inputDigest
  ) {
    logBatchInstrumentationError(
      "left partial batch pending after input repair failure",
      emissionIssue ??
        new BatchEmissionError(
          "Groq Batch child input repair emission was incomplete",
        ),
    );
    await flush();
    return false;
  }
  await flush();
  return true;
}

async function collectBatch(
  args: CollectGroqBatchTraceArgs<GroqBatchLike>,
  collectParent: ReturnType<typeof getSpanParentObject>,
): Promise<void> {
  const status = read(args.batch, "status");
  if (typeof status !== "string" || !TERMINAL_STATUSES.has(status)) {
    return;
  }
  const startedContext = await unboundBatchContextFromValues(args.batch);
  let signedContext: BatchContext | undefined;
  if (startedContext) {
    if (
      !(await validateBatchTraceBinding(
        args.batch,
        startedContext,
        args.traceContext,
      ))
    ) {
      logBatchInstrumentationError(
        "left started batch spans pending",
        new Error("Groq Batch provider ID binding is absent or invalid"),
      );
      return;
    }
    signedContext = startedContext;
  } else {
    logBatchInstrumentationError(
      "could not resume signed context; attempting collect-only tracing",
      new Error("Groq Batch signed context is absent or invalid"),
    );
  }
  if (status === "completed") {
    const sourceIssue = completedBatchResultSourcesIssue(args);
    if (sourceIssue) {
      logBatchInstrumentationError(
        signedContext
          ? "left completed batch spans pending without consuming partial files"
          : "skipped collect-only tracing without consuming partial files",
        sourceIssue,
      );
      return;
    }
  }
  const inputData = await validatedBatchInputs(
    args.inputFile,
    signedContext,
    !signedContext || signedContext.repairInputs,
  );
  const inputIssue = inputData.issues[0];
  if (
    inputIssue instanceof BatchFatalError ||
    (!signedContext && !inputData.inputs)
  ) {
    logBatchInstrumentationError(
      signedContext
        ? "left batch spans pending"
        : "could not establish collect-only correlation",
      inputIssue ??
        new Error("Groq Batch collect-only input could not be staged"),
    );
    return;
  }
  if (inputIssue) {
    logBatchInstrumentationError(
      "skipped invalid input records while collecting valid requests",
      inputIssue,
    );
  }

  if (signedContext) {
    if (
      signedContext.repairInputs &&
      !inputData.inputs &&
      !(await repairSignedBatchInputs(args.inputFile, signedContext, inputData))
    ) {
      return;
    }
    await completeSignedBatch(args, signedContext, inputData, status);
    return;
  }
  const context = await collectOnlyBatchContext(
    args.batch,
    inputData,
    collectParent,
    getCurrentUnixTimestamp(),
  );
  if (!context) {
    logBatchInstrumentationError(
      "could not establish collect-only correlation",
      new Error("Groq Batch has no routable active Braintrust parent"),
    );
    return;
  }
  await completeCollectOnlyBatch(args, context, inputData, status);
}

export const interceptGroqBatchTraceCollect: Parameters<
  typeof groqChannels.batchesCollectTrace.intercept
>[0] = (target, thisArg, args) => {
  const collectParent = getSpanParentObject();
  return Promise.resolve(Reflect.apply(target, thisArg, args)).then(
    async (batch) => {
      try {
        await collectBatch({ ...args[0], batch }, collectParent);
      } catch (error) {
        logBatchInstrumentationError("could not collect batch", error);
      }
      return batch;
    },
  );
};

function submissionError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(
    typeof value === "string" ? value : "Groq Batch submission failed",
  );
}

async function failBatch(args: FailGroqBatchTraceArgs): Promise<void> {
  const context = await unboundBatchContextFromValues(args.params);
  if (!context) {
    logBatchInstrumentationError(
      "could not resume submission failure",
      new Error("Groq Batch signed context is absent or invalid"),
    );
    return;
  }
  const inputData = await validatedBatchInputs(
    replayableBatchInput(args.input),
    context,
  );
  const inputIssue = inputData.issues[0];
  if (inputIssue instanceof BatchFatalError) {
    logBatchInstrumentationError("left batch spans pending", inputIssue);
    return;
  }
  if (inputIssue) {
    logBatchInstrumentationError(
      "skipped invalid input records while failing valid requests",
      inputIssue,
    );
  }
  const error = submissionError(args.error);
  const endTime = Math.max(getCurrentUnixTimestamp(), context.startTime);
  await flush();
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  await flush();
  const flushState: BatchFlushState = { spansSinceFlush: 0 };
  let emissionFailed = false;
  const replayData = await scanBatchInputs(replayableBatchInput(args.input), {
    onInput: async (input) => {
      try {
        const child = await startBatchChild(context, taskParent, input);
        child.log({ error });
        child.end({ endTime });
        await applyBatchWriteBackpressure(flushState);
      } catch (instrumentationError) {
        emissionFailed = true;
        logBatchInstrumentationError(
          "could not fail pending child",
          instrumentationError,
        );
      }
    },
  });
  const replayInputIssue = replayData.issues[0];
  if (replayInputIssue && !(replayInputIssue instanceof BatchFatalError)) {
    logBatchInstrumentationError(
      "skipped invalid replay records while failing valid requests",
      replayInputIssue,
    );
  }
  const replayIssue = batchReplayIssue(
    replayData,
    inputData,
    "Groq Batch replayable failure input changed between passes",
  );
  if (replayIssue || emissionFailed) {
    logBatchInstrumentationError(
      "left submission failure retryable",
      replayIssue ?? new Error("Groq Batch child span emission was incomplete"),
    );
    await flush();
    return;
  }
  task.log({ error });
  task.end({ endTime });
  await flush();
}

export const interceptGroqBatchTraceFail: Parameters<
  typeof groqChannels.batchesFailTrace.intercept
>[0] = async (target, thisArg, args) => {
  const result = await Reflect.apply(target, thisArg, args);
  try {
    await failBatch(args[0]);
  } catch (error) {
    logBatchInstrumentationError("could not fail batch", error);
  }
  return result;
};
