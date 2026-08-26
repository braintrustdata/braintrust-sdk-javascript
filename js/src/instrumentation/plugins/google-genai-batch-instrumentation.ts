import { debugLogger } from "../../debug-logger";
import {
  _internalGetGlobalState,
  _internalStartSpanWithInitialMerge,
  getSpanParentObject,
  NOOP_SPAN,
  type Span,
  withCurrent,
} from "../../logger";
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
import {
  extractGoogleGenAIGenerationMetadata,
  extractGoogleGenAISystemInstruction,
  extractGoogleGenAIResponseMetadata,
  populateGoogleGenAIUsageMetrics,
  serializeGoogleGenAIRequestContents,
  serializeGoogleGenAIResponse,
} from "./google-genai-shared";
import type {
  CompleteGeminiDeveloperBatchTraceArgs,
  GeminiDeveloperBatchCreateParams as GoogleGenAIBatchCreateParams,
  GeminiDeveloperBatchFile as GoogleGenAIBatchFile,
  GeminiDeveloperBatchLike as GoogleGenAIBatch,
  StartGeminiDeveloperBatchTraceArgs,
} from "../../google-genai-batch-types";

type GoogleGenAIBatchStartTraceArgs =
  StartGeminiDeveloperBatchTraceArgs<GoogleGenAIBatch>;
type GoogleGenAIBatchCompleteTraceArgs =
  CompleteGeminiDeveloperBatchTraceArgs<GoogleGenAIBatch>;

const TERMINAL_STATES = new Set([
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
  "JOB_STATE_PARTIALLY_SUCCEEDED",
]);
const INPUT_DIGEST_CHUNK_SIZE = 1024 * 1024;
const BATCH_TRACE_FLUSH_MAX_ROWS = 100;
const BATCH_TRACE_FLUSH_MAX_BYTES = 1024 * 1024;
const CONTEXT_NAMESPACE = "braintrust.google_genai.batch_context";
const UTF8_ENCODER = new TextEncoder();

type BatchSourceKind = "file" | "inline";

type BatchContext = {
  version: 1;
  parent: string;
  batchName: string;
  model: string;
  sourceKind: BatchSourceKind;
  inputDigest: string;
  startTime: number;
  operationNonce: string;
};

type SerializedBatchContext = BatchContext & { signature: string };

type BatchInputRecord = {
  correlationId: string;
  raw: unknown;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

type BatchInputIndex = {
  ids: Set<string>;
  inputDigest: string;
  models: Map<string, string>;
};

type PreparedBatchInputs = {
  inputIndex: BatchInputIndex;
  spanInput: GoogleGenAIBatchFile | undefined;
};

class BatchTraceFlusher {
  private pendingRows = 0;
  private pendingBytes = 0;

  constructor(private readonly task: Span) {}

  async add(rowBytes: number): Promise<void> {
    this.pendingRows += 1;
    this.pendingBytes += rowBytes;
    if (
      this.pendingRows >= BATCH_TRACE_FLUSH_MAX_ROWS ||
      this.pendingBytes >= BATCH_TRACE_FLUSH_MAX_BYTES
    ) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    await this.task.flush();
    this.pendingRows = 0;
    this.pendingBytes = 0;
  }
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? 0
      : UTF8_ENCODER.encode(serialized).byteLength;
  } catch {
    // Force immediate backpressure when an unexpected value cannot be sized.
    return BATCH_TRACE_FLUSH_MAX_BYTES;
  }
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
  debugLogger.debug(`Google GenAI Batch instrumentation ${context}:`, error);
}

function batchSourceKind(
  params: GoogleGenAIBatchCreateParams,
): BatchSourceKind | undefined {
  const src = read(params, "src");
  if (Array.isArray(src)) {
    return "inline";
  }
  if (typeof src === "string") {
    return src.startsWith("files/") ? "file" : undefined;
  }
  if (isObject(src)) {
    if (Array.isArray(read(src, "inlinedRequests"))) {
      return "inline";
    }
    const fileName = read(src, "fileName");
    if (typeof fileName === "string" && fileName.startsWith("files/")) {
      return "file";
    }
  }
  return undefined;
}

function batchModel(
  batch: GoogleGenAIBatch,
  params: GoogleGenAIBatchCreateParams,
): string | undefined {
  const providerModel = read(batch, "model");
  if (typeof providerModel === "string" && providerModel.length > 0) {
    return providerModel;
  }
  const paramsModel = read(params, "model");
  if (typeof paramsModel === "string" && paramsModel.length > 0) {
    return paramsModel;
  }
  return undefined;
}

function normalizedModel(value: string): string {
  const modelsIndex = value.lastIndexOf("/models/");
  if (modelsIndex !== -1) {
    return value.slice(modelsIndex + "/models/".length);
  }
  return value.startsWith("models/") ? value.slice("models/".length) : value;
}

function modelsMatch(left: string, right: string): boolean {
  return left === right || normalizedModel(left) === normalizedModel(right);
}

function parseProviderTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined;
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
  // SpanComponents requires all three span identifiers together.
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

function batchContextPayload(context: BatchContext): string {
  return JSON.stringify([CONTEXT_NAMESPACE, context]);
}

async function importBatchSigningKey(secret: string) {
  return await globalThis.crypto.subtle.importKey(
    "raw",
    UTF8_ENCODER.encode(secret),
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
      UTF8_ENCODER.encode(batchContextPayload(context)),
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
      UTF8_ENCODER.encode(batchContextPayload(context)),
    );
  } catch {
    return false;
  }
}

async function parseBatchContext(
  value: unknown,
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
    typeof parsed.batchName !== "string" ||
    typeof parsed.model !== "string" ||
    (parsed.sourceKind !== "inline" && parsed.sourceKind !== "file") ||
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
    batchName: parsed.batchName,
    model: parsed.model,
    sourceKind: parsed.sourceKind,
    inputDigest: parsed.inputDigest,
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

async function deterministicDigest(namespace: string, ...parts: string[]) {
  const encoded = UTF8_ENCODER.encode(
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

async function batchOperationNonce(
  parent: string,
  batchName: string,
  model: string,
  sourceKind: BatchSourceKind,
  inputDigest: string,
): Promise<string> {
  return digestHex(
    await deterministicDigest(
      "google-genai:batch:operation",
      parent,
      batchName,
      model,
      sourceKind,
      inputDigest,
    ),
    16,
  );
}

async function createBatchContext(
  fields: Omit<BatchContext, "version" | "operationNonce">,
): Promise<BatchContext> {
  return {
    version: 1,
    ...fields,
    operationNonce: await batchOperationNonce(
      fields.parent,
      fields.batchName,
      fields.model,
      fields.sourceKind,
      fields.inputDigest,
    ),
  };
}

async function batchSpanIds(operationNonce: string): Promise<{
  rowId: string;
  spanId: string;
  rootSpanId: string;
}> {
  const [row, span, root] = await Promise.all([
    deterministicDigest("google-genai:batch:row", operationNonce),
    deterministicDigest("google-genai:batch:span", operationNonce),
    deterministicDigest("google-genai:batch:root", operationNonce),
  ]);
  return {
    rowId: digestUuid(row),
    spanId: digestHex(span, 8),
    rootSpanId: digestHex(root, 16),
  };
}

async function childSpanIds(operationNonce: string, correlationId: string) {
  const [row, span] = await Promise.all([
    deterministicDigest(
      "google-genai:batch:child:row",
      operationNonce,
      correlationId,
    ),
    deterministicDigest(
      "google-genai:batch:child:span",
      operationNonce,
      correlationId,
    ),
  ]);
  return { rowId: digestUuid(row), spanId: digestHex(span, 8) };
}

async function startBatchSpan(context: BatchContext): Promise<Span> {
  const ids = await batchSpanIds(context.operationNonce);
  const parent = SpanComponentsV4.fromStr(context.parent);
  const hasParentSpan = Boolean(
    parent.data.row_id && parent.data.span_id && parent.data.root_span_id,
  );
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMerge(
      withSpanInstrumentationName(
        {
          name: "google-genai.batch",
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
            metadata: {
              batch_name: context.batchName,
              model: context.model,
              provider: "google",
            },
          },
        },
        INSTRUMENTATION_NAMES.GOOGLE_GENAI,
      ),
      { useParentSpanIdsForObjectParent: true },
    ),
  );
}

async function startBatchChild(
  context: BatchContext,
  taskParent: string,
  correlationId: string,
  spanData?: Pick<BatchInputRecord, "input" | "metadata">,
): Promise<Span> {
  const ids = await childSpanIds(context.operationNonce, correlationId);
  const metadata = spanData
    ? {
        ...spanData.metadata,
        model: spanData.metadata.model ?? context.model,
        provider: "google",
      }
    : { provider: "google" };
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMerge(
      withSpanInstrumentationName(
        {
          name: "generate_content",
          type: SpanTypeAttribute.LLM,
          parent: taskParent,
          spanId: ids.spanId,
          startTime: context.startTime,
          event: {
            id: ids.rowId,
            ...(spanData ? { input: spanData.input } : {}),
            metadata,
          },
        },
        INSTRUMENTATION_NAMES.GOOGLE_GENAI,
      ),
    ),
  );
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

async function replayableBatchInput(
  input: GoogleGenAIBatchFile | undefined,
): Promise<[GoogleGenAIBatchFile, GoogleGenAIBatchFile]> {
  if (input === undefined) {
    throw new Error("Google GenAI Batch file input is required");
  }
  const resolved = await input;
  if (typeof resolved === "string" || resolved instanceof Uint8Array) {
    return [resolved, resolved];
  }

  const body = read(resolved, "body");
  if (
    typeof read(resolved, "clone") === "function" &&
    isObject(body) &&
    typeof read(body, "getReader") === "function"
  ) {
    // A Response body cannot be inspected without either consuming the
    // caller's object or teeing it and buffering its unread branch. Ask for a
    // replayable representation instead and leave the Response untouched.
    throw new Error(
      "Google GenAI Batch input Response is not replayable; pass text, bytes, or a replayable iterable",
    );
  }

  for (const iteratorSymbol of [
    Symbol.iterator,
    Symbol.asyncIterator,
  ] as const) {
    const iteratorFactory = read(resolved, iteratorSymbol);
    if (typeof iteratorFactory !== "function") {
      continue;
    }
    const iterator: unknown = Reflect.apply(iteratorFactory, resolved, []);
    if (iterator === resolved) {
      throw new Error(
        "Google GenAI Batch deterministic tracing requires a replayable input",
      );
    }
  }
  return [resolved, resolved];
}

async function* textRecords(text: string): AsyncGenerator<unknown> {
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(offset, end).replace(/\r$/, "");
    offset = newline === -1 ? text.length : newline + 1;
    if (line.trim()) {
      yield JSON.parse(line);
    }
  }
}

async function* jsonlRecords(
  file: GoogleGenAIBatchFile,
): AsyncGenerator<unknown> {
  const resolvedFile = await file;
  if (typeof resolvedFile === "string") {
    yield* textRecords(resolvedFile);
    return;
  }
  if (resolvedFile instanceof Uint8Array) {
    yield* textRecords(new TextDecoder().decode(resolvedFile));
    return;
  }

  const body = read(resolvedFile, "body");
  const getReader = read(body, "getReader");
  if (isObject(body) && typeof getReader === "function") {
    const reader = Reflect.apply(getReader, body, []);
    if (!isObject(reader)) {
      throw new Error("Google GenAI Batch response has an invalid body reader");
    }
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const readChunk = read(reader, "read");
        if (typeof readChunk !== "function") {
          throw new Error("Google GenAI Batch body reader has no read method");
        }
        const chunk = await Reflect.apply(readChunk, reader, []);
        if (!isObject(chunk)) {
          throw new Error("Google GenAI Batch body returned an invalid chunk");
        }
        if (chunk.done === true) {
          pending += decoder.decode();
          break;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("Google GenAI Batch body returned a non-byte chunk");
        }
        pending += decoder.decode(chunk.value, { stream: true });
        const records = pending.split("\n");
        pending = records.pop() ?? "";
        for (const record of records) {
          const line = record.replace(/\r$/, "");
          if (line.trim()) {
            yield JSON.parse(line);
          }
        }
      }
      if (pending.trim()) {
        yield JSON.parse(pending.replace(/\r$/, ""));
      }
    } finally {
      const releaseLock = read(reader, "releaseLock");
      if (typeof releaseLock === "function") {
        Reflect.apply(releaseLock, reader, []);
      }
    }
    return;
  }

  if (!isBatchRecordIterable(resolvedFile)) {
    throw new Error("Google GenAI Batch JSONL source is invalid");
  }

  const decoder = new TextDecoder();
  let pending = "";
  let sawTextChunk = false;
  for await (const value of resolvedFile) {
    if (typeof value === "string" || value instanceof Uint8Array) {
      sawTextChunk = true;
      pending +=
        typeof value === "string"
          ? value
          : decoder.decode(value, { stream: true });
      const records = pending.split("\n");
      pending = records.pop() ?? "";
      for (const record of records) {
        const line = record.replace(/\r$/, "");
        if (line.trim()) {
          yield JSON.parse(line);
        }
      }
    } else {
      if (sawTextChunk || pending.length > 0) {
        throw new Error("Google GenAI Batch JSONL source mixes record types");
      }
      yield value;
    }
  }
  if (sawTextChunk) {
    pending += decoder.decode();
    if (pending.trim()) {
      yield JSON.parse(pending.replace(/\r$/, ""));
    }
  }
}

function batchSpanData(
  request: unknown,
  defaultModel: string,
  attachmentSeed?: Uint8Array,
): Pick<BatchInputRecord, "input" | "metadata"> {
  if (!isObject(request) || Array.isArray(request)) {
    throw new Error("Google GenAI Batch request is invalid");
  }
  const requestModel = read(request, "model");
  const model =
    typeof requestModel === "string" && requestModel.length > 0
      ? requestModel
      : defaultModel;
  const contents = read(request, "contents");
  if (contents === undefined) {
    throw new Error("Google GenAI Batch request has no contents");
  }

  const requestConfig = read(request, "config");
  const systemInstruction = extractGoogleGenAISystemInstruction(requestConfig);

  const input: Record<string, unknown> = {
    model,
    contents: serializeGoogleGenAIRequestContents(
      contents,
      systemInstruction,
      attachmentSeed
        ? {
            attachmentKey: (index) =>
              deterministicAttachmentKey(attachmentSeed, index),
          }
        : { preserveInlineData: true },
    ),
  };
  return {
    input,
    metadata: extractGoogleGenAIGenerationMetadata(requestConfig, model),
  };
}

async function batchInputAttachmentSeed(
  operationNonce: string | undefined,
  correlationId: string,
): Promise<Uint8Array | undefined> {
  if (!operationNonce) {
    return undefined;
  }
  return await deterministicDigest(
    "google-genai:batch:input-attachment",
    operationNonce,
    correlationId,
  );
}

async function* batchInputRecords(
  params: GoogleGenAIBatchCreateParams,
  input: GoogleGenAIBatchFile | undefined,
  sourceKind: BatchSourceKind,
  model: string,
  operationNonce?: string,
): AsyncGenerator<BatchInputRecord> {
  if (sourceKind === "inline") {
    const src = read(params, "src");
    const requests = Array.isArray(src) ? src : read(src, "inlinedRequests");
    if (!Array.isArray(requests)) {
      throw new Error("Google GenAI Batch inline source is invalid");
    }
    for (let index = 0; index < requests.length; index++) {
      const raw = requests[index];
      const correlationId = `inline:${index}`;
      const attachmentSeed = await batchInputAttachmentSeed(
        operationNonce,
        correlationId,
      );
      const spanData = batchSpanData(raw, model, attachmentSeed);
      yield {
        correlationId,
        raw,
        input: spanData.input,
        metadata: {
          ...spanData.metadata,
          batch_request_index: index,
        },
      };
    }
    return;
  }

  if (input === undefined) {
    throw new Error("Google GenAI Batch file input is required");
  }
  for await (const raw of jsonlRecords(input)) {
    const key = read(raw, "key");
    const request = read(raw, "request");
    if (typeof key !== "string" || key.length === 0 || request === undefined) {
      throw new Error("Google GenAI Batch file record is invalid");
    }
    const correlationId = `key:${key}`;
    const attachmentSeed = await batchInputAttachmentSeed(
      operationNonce,
      correlationId,
    );
    const spanData = batchSpanData(request, model, attachmentSeed);
    yield {
      correlationId,
      raw,
      input: spanData.input,
      metadata: {
        ...spanData.metadata,
        batch_key: key,
      },
    };
  }
}

function canonicalizeJSON(
  value: unknown,
  ancestors: Set<object> = new Set(),
): unknown {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error("Google GenAI Batch input has a circular value");
    }
    ancestors.add(value);
    try {
      return value.map((entry) => canonicalizeJSON(entry, ancestors) ?? null);
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isObject(value)) {
    throw new Error("Google GenAI Batch input has a non-JSON value");
  }
  if (ancestors.has(value)) {
    throw new Error("Google GenAI Batch input has a circular value");
  }
  ancestors.add(value);
  try {
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(value).sort()) {
      const canonical = canonicalizeJSON(read(value, key), ancestors);
      if (canonical !== undefined) {
        entries.push([key, canonical]);
      }
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

async function readBatchInputs(
  params: GoogleGenAIBatchCreateParams,
  input: GoogleGenAIBatchFile | undefined,
  sourceKind: BatchSourceKind,
  model: string,
  onRecord?: (record: BatchInputRecord, byteLength: number) => Promise<void>,
  operationNonce?: string,
): Promise<BatchInputIndex> {
  const ids = new Set<string>();
  const models = new Map<string, string>();
  const chunkDigests: string[] = [];
  let digestChunk = "";
  for await (const record of batchInputRecords(
    params,
    input,
    sourceKind,
    model,
    operationNonce,
  )) {
    if (ids.has(record.correlationId)) {
      throw new Error("Google GenAI Batch input contains a duplicate key");
    }
    ids.add(record.correlationId);
    const recordModel = read(record.input, "model");
    if (typeof recordModel === "string") {
      models.set(record.correlationId, recordModel);
    }
    const canonicalRecord = JSON.stringify({
      id: record.correlationId,
      value: canonicalizeJSON(record.raw),
    });
    const byteLength = UTF8_ENCODER.encode(canonicalRecord).byteLength;
    const framedRecord = `${canonicalRecord.length}:${canonicalRecord}`;
    if (
      digestChunk.length > 0 &&
      digestChunk.length + framedRecord.length > INPUT_DIGEST_CHUNK_SIZE
    ) {
      chunkDigests.push(
        digestHex(
          await deterministicDigest(
            "google-genai:batch:input:chunk",
            digestChunk,
          ),
          32,
        ),
      );
      digestChunk = "";
    }
    digestChunk += framedRecord;
    await onRecord?.(record, byteLength);
  }
  if (ids.size === 0) {
    throw new Error("Google GenAI Batch input is empty");
  }
  chunkDigests.push(
    digestHex(
      await deterministicDigest("google-genai:batch:input:chunk", digestChunk),
      32,
    ),
  );
  return {
    ids,
    inputDigest: digestHex(
      await deterministicDigest(
        "google-genai:batch:input",
        chunkDigests.join(""),
      ),
      32,
    ),
    models,
  };
}

async function prepareBatchInputPasses(
  params: GoogleGenAIBatchCreateParams,
  input: GoogleGenAIBatchFile | undefined,
  sourceKind: BatchSourceKind,
  model: string,
): Promise<PreparedBatchInputs> {
  let digestInput = input;
  let spanInput = input;
  if (sourceKind === "file") {
    [digestInput, spanInput] = await replayableBatchInput(input);
  }
  return {
    inputIndex: await readBatchInputs(params, digestInput, sourceKind, model),
    spanInput,
  };
}

async function emitBatchInputSpans(args: {
  context: BatchContext;
  flusher: BatchTraceFlusher;
  input: GoogleGenAIBatchFile | undefined;
  model: string;
  params: GoogleGenAIBatchCreateParams;
  sourceKind: BatchSourceKind;
  startedIds: Set<string>;
  taskParent: string;
}): Promise<void> {
  const emittedInputs = await readBatchInputs(
    args.params,
    args.input,
    args.sourceKind,
    args.model,
    async (record, byteLength) => {
      await startBatchChild(
        args.context,
        args.taskParent,
        record.correlationId,
        record,
      );
      args.startedIds.add(record.correlationId);
      await args.flusher.add(byteLength);
    },
    args.context.operationNonce,
  );
  if (emittedInputs.inputDigest !== args.context.inputDigest) {
    throw new Error("Google GenAI Batch input changed while tracing");
  }
}

async function signAndSerializeBatchContext(
  context: BatchContext,
  signingSecret: string,
): Promise<string> {
  const signature = await signBatchContext(context, signingSecret);
  if (!signature) {
    throw new Error("Google GenAI Batch context could not be signed");
  }
  return JSON.stringify({
    ...context,
    signature,
  } satisfies SerializedBatchContext);
}

async function endStartedBatchWithError(
  context: BatchContext,
  task: Span,
  taskParent: string,
  ids: Set<string>,
  error: unknown,
): Promise<void> {
  const spanError =
    error instanceof Error
      ? error
      : new Error("Google GenAI Batch trace setup failed");
  const endTime = Math.max(getCurrentUnixTimestamp(), context.startTime);
  const flusher = new BatchTraceFlusher(task);
  for (const id of ids) {
    const child = await startBatchChild(context, taskParent, id);
    child.log({ error: spanError });
    child.end({ endTime });
    await flusher.add(spanError.message.length);
  }
  task.log({ error: spanError });
  task.end({ endTime });
  await flusher.flush();
}

async function startBatchTrace(
  args: GoogleGenAIBatchStartTraceArgs,
): Promise<string | undefined> {
  const batchName = read(args.batch, "name");
  const model = batchModel(args.batch, args.params);
  const sourceKind = batchSourceKind(args.params);
  if (
    typeof batchName !== "string" ||
    batchName.length === 0 ||
    !model ||
    !sourceKind
  ) {
    logBatchInstrumentationError(
      "skipped unsupported batch",
      "missing batch name, model, or Gemini source",
    );
    return undefined;
  }
  const exportedParent = await exportMinimalParent(getSpanParentObject());
  const signingSecret =
    _internalGetGlobalState()._internalGetTraceContextSigningSecret();
  if (!exportedParent || !signingSecret) {
    logBatchInstrumentationError(
      "skipped batch",
      "no routable parent or signing secret",
    );
    return undefined;
  }
  const providerStart = parseProviderTimestamp(read(args.batch, "createTime"));
  const startTime = providerStart ?? getCurrentUnixTimestamp();
  let preparedInputs: PreparedBatchInputs;
  try {
    preparedInputs = await prepareBatchInputPasses(
      args.params,
      args.input,
      sourceKind,
      model,
    );
  } catch (error) {
    logBatchInstrumentationError("could not validate batch input", error);
    return undefined;
  }
  const context = await createBatchContext({
    parent: exportedParent,
    batchName,
    model,
    sourceKind,
    inputDigest: preparedInputs.inputIndex.inputDigest,
    startTime,
  });
  const task = await startBatchSpan(context);
  const taskParent = await task.export();
  const flusher = new BatchTraceFlusher(task);
  const startedIds = new Set<string>();
  try {
    await emitBatchInputSpans({
      context,
      flusher,
      input: preparedInputs.spanInput,
      model,
      params: args.params,
      sourceKind,
      startedIds,
      taskParent,
    });
    const serializedContext = await signAndSerializeBatchContext(
      context,
      signingSecret,
    );
    await flusher.flush();
    return serializedContext;
  } catch (error) {
    logBatchInstrumentationError("could not start batch trace", error);
    await endStartedBatchWithError(
      context,
      task,
      taskParent,
      startedIds,
      error,
    );
    return undefined;
  }
}

function resultError(value: unknown): Error | undefined {
  const error = read(value, "error");
  if (!isObject(error)) {
    return undefined;
  }
  const message = read(error, "message");
  return new Error(
    typeof message === "string" ? message : "Google GenAI Batch request failed",
  );
}

function hasUsableBatchOutcome(
  value: unknown,
): value is Record<string, unknown> {
  if (!isObject(value)) {
    return false;
  }
  const hasResponse = isObject(read(value, "response"));
  const hasError = isObject(read(value, "error"));
  return hasResponse !== hasError;
}

type PreparedBatchOutcome =
  | { byteLength: number; digest: string; error: Error }
  | {
      byteLength: number;
      digest: string;
      metadata: Record<string, unknown>;
      metrics: Record<string, number>;
      output: unknown;
    };

function deterministicAttachmentKey(seed: Uint8Array, index: number): string {
  const bytes = seed.slice(0, 16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(12, view.getUint32(12) ^ index);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return digestUuid(bytes);
}

async function prepareBatchOutcome(
  context: BatchContext,
  correlationId: string,
  value: unknown,
): Promise<PreparedBatchOutcome | undefined> {
  if (!hasUsableBatchOutcome(value)) {
    return undefined;
  }
  try {
    const error = resultError(value);
    if (error) {
      const digest = digestHex(
        await deterministicDigest(
          "google-genai:batch:outcome",
          JSON.stringify({ error: error.message }),
        ),
        32,
      );
      return { byteLength: error.message.length, digest, error };
    }
    const response = read(value, "response");
    if (!isObject(response)) {
      return undefined;
    }
    const metrics: Record<string, number> = {};
    populateGoogleGenAIUsageMetrics(metrics, read(response, "usageMetadata"));
    const rawOutput = serializeGoogleGenAIResponse(response, {
      preserveInlineData: true,
    });
    if (!rawOutput) {
      return undefined;
    }
    const serializedDigestInput = JSON.stringify(
      canonicalizeJSON({ metrics, output: rawOutput }),
    );
    if (serializedDigestInput === undefined) {
      return undefined;
    }
    const digest = digestHex(
      await deterministicDigest(
        "google-genai:batch:outcome",
        serializedDigestInput,
      ),
      32,
    );
    const attachmentSeed = await deterministicDigest(
      "google-genai:batch:attachment",
      context.operationNonce,
      correlationId,
      digest,
    );
    const output = serializeGoogleGenAIResponse(response, {
      attachmentKey: (index) =>
        deterministicAttachmentKey(attachmentSeed, index),
    });
    if (!output) {
      return undefined;
    }
    const metadata = {
      ...extractGoogleGenAIResponseMetadata(response, {
        attachmentKey: (index) =>
          deterministicAttachmentKey(attachmentSeed, 0x80000000 + index),
      }),
      provider: "google",
    };
    return {
      byteLength: serializedByteLength({ metadata, metrics, output }),
      digest,
      metadata,
      metrics,
      output,
    };
  } catch {
    return undefined;
  }
}

async function completeBatchResult(
  context: BatchContext,
  taskParent: string,
  correlationId: string,
  outcome: PreparedBatchOutcome,
  endTime: number,
): Promise<void> {
  const child = await startBatchChild(context, taskParent, correlationId);
  try {
    if ("error" in outcome) {
      child.log({ error: outcome.error });
    } else {
      child.log({
        output: outcome.output,
        metadata: outcome.metadata,
        metrics: outcome.metrics,
      });
    }
  } catch (error) {
    child.log({ error });
  } finally {
    child.end({ endTime });
  }
}

async function resetBatchChild(
  context: BatchContext,
  taskParent: string,
  correlationId: string,
  requestModel: string,
): Promise<Span> {
  const child = await startBatchChild(context, taskParent, correlationId);
  child.log({
    error: null,
    metadata: {
      groundingMetadata: null,
      model: requestModel,
      provider: "google",
    },
    // A merge-row null intentionally replaces all prior terminal metrics.
    // Restore the original start immediately so the child remains pending.
    metrics: null,
    output: null,
  });
  child.log({ metrics: { start: context.startTime } });
  return child;
}

function terminalEndTime(batch: GoogleGenAIBatch, startTime: number): number {
  const providerEnd =
    parseProviderTimestamp(read(batch, "endTime")) ??
    parseProviderTimestamp(read(batch, "updateTime"));
  return providerEnd !== undefined && providerEnd >= startTime
    ? providerEnd
    : Math.max(getCurrentUnixTimestamp(), startTime);
}

function taskCompletionMetadata(
  batch: GoogleGenAIBatch,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const state = read(batch, "state");
  if (typeof state === "string") {
    metadata.state = state;
  }
  const stats = read(batch, "completionStats");
  for (const [source, target] of [
    ["successfulCount", "successful_request_count"],
    ["failedCount", "failed_request_count"],
    ["incompleteCount", "incomplete_request_count"],
  ] as const) {
    const value = read(stats, source);
    if (typeof value === "string" && /^\d+$/.test(value)) {
      metadata[target] = Number(value);
    }
  }
  return metadata;
}

async function completeBatch(
  args: GoogleGenAIBatchCompleteTraceArgs,
): Promise<string | undefined> {
  const state = read(args.batch, "state");
  if (typeof state !== "string" || !TERMINAL_STATES.has(state)) {
    return typeof args.traceContext === "string"
      ? args.traceContext
      : undefined;
  }
  const batchName = read(args.batch, "name");
  const sourceKind = batchSourceKind(args.params);
  const model = batchModel(args.batch, args.params);
  if (
    typeof batchName !== "string" ||
    batchName.length === 0 ||
    !sourceKind ||
    !model ||
    model.length === 0
  ) {
    logBatchInstrumentationError(
      "skipped unsupported completion",
      "missing batch name, model, or Gemini source",
    );
    return undefined;
  }

  let context = await parseBatchContext(args.traceContext);
  let resumableContext = context ? args.traceContext : undefined;
  if (
    context &&
    (batchName !== context.batchName ||
      sourceKind !== context.sourceKind ||
      !modelsMatch(model, context.model))
  ) {
    logBatchInstrumentationError(
      "could not resume supplied context",
      "batch context does not match the supplied batch; collecting a new trace",
    );
    context = undefined;
    resumableContext = undefined;
  }

  let inputs: BatchInputIndex;
  let task: Span;
  let taskParent: string;
  let flusher: BatchTraceFlusher;
  if (!context) {
    const parent = await exportMinimalParent(getSpanParentObject());
    const signingSecret =
      _internalGetGlobalState()._internalGetTraceContextSigningSecret();
    if (!parent || !signingSecret) {
      logBatchInstrumentationError(
        "skipped collect-only batch",
        "no routable Braintrust parent or signing secret",
      );
      return undefined;
    }
    let preparedInputs: PreparedBatchInputs;
    try {
      preparedInputs = await prepareBatchInputPasses(
        args.params,
        args.input,
        sourceKind,
        model,
      );
      inputs = preparedInputs.inputIndex;
    } catch (error) {
      logBatchInstrumentationError(
        "could not validate collect-only batch input",
        error,
      );
      return undefined;
    }
    const collectionTime = getCurrentUnixTimestamp();
    const providerStart =
      parseProviderTimestamp(read(args.batch, "createTime")) ??
      parseProviderTimestamp(read(args.batch, "startTime"));
    context = await createBatchContext({
      parent,
      batchName,
      model,
      sourceKind,
      inputDigest: inputs.inputDigest,
      startTime: providerStart ?? collectionTime,
    });
    const collectContext = context;
    task = await startBatchSpan(collectContext);
    taskParent = await task.export();
    flusher = new BatchTraceFlusher(task);
    const startedIds = new Set<string>();
    try {
      await emitBatchInputSpans({
        context: collectContext,
        flusher,
        input: preparedInputs.spanInput,
        model,
        params: args.params,
        sourceKind,
        startedIds,
        taskParent,
      });
      resumableContext = await signAndSerializeBatchContext(
        collectContext,
        signingSecret,
      );
    } catch (error) {
      logBatchInstrumentationError(
        "could not create collect-only batch trace",
        error,
      );
      await endStartedBatchWithError(
        collectContext,
        task,
        taskParent,
        startedIds,
        error,
      );
      return undefined;
    }
  } else {
    inputs = await readBatchInputs(
      args.params,
      args.input,
      sourceKind,
      context.model,
    );
    if (inputs.inputDigest !== context.inputDigest) {
      logBatchInstrumentationError(
        "could not resume supplied context",
        "batch input does not match the signed context",
      );
      return resumableContext;
    }
    // startGeminiDeveloperBatchTrace durably flushes the input rows.
    // Completion therefore only needs to stream result merges and never
    // retains the normalized request payloads in memory.
    task = await startBatchSpan(context);
    taskParent = await task.export();
    flusher = new BatchTraceFlusher(task);
  }

  const endTime = terminalEndTime(args.batch, context.startTime);
  const seen = new Set<string>();
  const outcomeDigests = new Map<string, string>();
  const ambiguous = new Set<string>();
  let firstIssue: Error | undefined;

  if (sourceKind === "inline") {
    const responses = read(read(args.batch, "dest"), "inlinedResponses");
    if (Array.isArray(responses)) {
      for (let index = 0; index < responses.length; index++) {
        const correlationId = `inline:${index}`;
        if (!inputs.ids.has(correlationId)) {
          firstIssue ??= new Error(
            "Google GenAI Batch inline result is invalid",
          );
          continue;
        }
        const outcome = await prepareBatchOutcome(
          context,
          correlationId,
          responses[index],
        );
        if (!outcome) {
          firstIssue ??= new Error(
            "Google GenAI Batch inline result is invalid",
          );
          continue;
        }
        await completeBatchResult(
          context,
          taskParent,
          correlationId,
          outcome,
          endTime,
        );
        seen.add(correlationId);
        await flusher.add(outcome.byteLength);
      }
    } else if (state === "JOB_STATE_SUCCEEDED") {
      firstIssue = new Error("Google GenAI Batch inline results are missing");
    }
  } else if (args.outputFile !== undefined) {
    try {
      for await (const result of jsonlRecords(args.outputFile)) {
        const key = read(result, "key");
        const correlationId = typeof key === "string" ? `key:${key}` : "";
        if (!correlationId || !inputs.ids.has(correlationId)) {
          firstIssue ??= new Error("Google GenAI Batch file result is invalid");
          continue;
        }
        const outcome = await prepareBatchOutcome(
          context,
          correlationId,
          result,
        );
        if (!outcome) {
          firstIssue ??= new Error("Google GenAI Batch file result is invalid");
          continue;
        }
        const outcomeDigest = outcome.digest;
        if (seen.has(correlationId)) {
          if (outcomeDigest !== outcomeDigests.get(correlationId)) {
            ambiguous.add(correlationId);
            await resetBatchChild(
              context,
              taskParent,
              correlationId,
              inputs.models.get(correlationId) ?? context.model,
            );
            firstIssue ??= new Error(
              "Google GenAI Batch file result is ambiguous",
            );
          } else {
            firstIssue ??= new Error(
              "Google GenAI Batch file result is duplicated",
            );
          }
          continue;
        }
        await completeBatchResult(
          context,
          taskParent,
          correlationId,
          outcome,
          endTime,
        );
        seen.add(correlationId);
        outcomeDigests.set(correlationId, outcomeDigest);
        await flusher.add(outcome.byteLength);
      }
    } catch (error) {
      firstIssue ??=
        error instanceof Error
          ? error
          : new Error("Google GenAI Batch output could not be read");
    }
  } else if (state === "JOB_STATE_SUCCEEDED") {
    firstIssue = new Error("Google GenAI Batch output file is missing");
  }

  const missing = [...inputs.ids].filter(
    (id) => !seen.has(id) || ambiguous.has(id),
  );
  if (state === "JOB_STATE_SUCCEEDED" && (missing.length > 0 || firstIssue)) {
    logBatchInstrumentationError(
      "left batch spans pending",
      firstIssue ?? new Error("Google GenAI Batch results are incomplete"),
    );
    await flusher.flush();
    return resumableContext;
  }

  if (firstIssue) {
    logBatchInstrumentationError(
      "ignored extraneous batch results",
      firstIssue,
    );
  }

  let terminalError: Error | undefined;
  if (state !== "JOB_STATE_SUCCEEDED") {
    const errorMessage = read(read(args.batch, "error"), "message");
    terminalError = new Error(
      typeof errorMessage === "string"
        ? errorMessage
        : `Google GenAI Batch ${state}`,
    );
  }
  for (const id of missing) {
    const child = await startBatchChild(context, taskParent, id);
    child.log({
      error: terminalError ?? new Error("Google GenAI Batch result is missing"),
    });
    child.end({ endTime });
    await flusher.add(terminalError?.message.length ?? 43);
  }
  task.log({
    metadata: taskCompletionMetadata(args.batch),
    ...(terminalError ? { error: terminalError } : {}),
  });
  task.end({ endTime });
  await flusher.flush();
  return resumableContext;
}

export async function startGoogleGenAIBatchTrace(
  args: GoogleGenAIBatchStartTraceArgs,
): Promise<string | undefined> {
  try {
    return await startBatchTrace(args);
  } catch (error) {
    logBatchInstrumentationError("could not start batch trace", error);
    return undefined;
  }
}

export async function completeGoogleGenAIBatchTrace(
  args: GoogleGenAIBatchCompleteTraceArgs,
): Promise<string | undefined> {
  try {
    return await completeBatch(args);
  } catch (error) {
    logBatchInstrumentationError("could not complete batch trace", error);
    return typeof args.traceContext === "string"
      ? args.traceContext
      : undefined;
  }
}
