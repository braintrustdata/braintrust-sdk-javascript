import { debugLogger } from "../../debug-logger";
import {
  _internalGetGlobalState,
  _internalResumeSpan,
  _internalStartSpanWithInitialMerge,
  _internalStartSpanWithInitialMergeAndParentSpanIds,
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
import {
  deterministicReplacer,
  SpanTypeAttribute,
  isObject,
} from "../../../util/index";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import {
  SpanComponentsV4,
  type SpanComponentsV4Data,
} from "../../../util/span_identifier_v4";
import type {
  CompleteMistralBatchTraceArgs,
  FailMistralBatchTraceArgs,
  MistralBatchCreateParams,
  MistralBatchCollectionContext,
  MistralBatchInput,
  MistralBatchLike,
  MistralBatchTraceCollection,
  StartMistralBatchTraceArgs,
} from "../../mistral-batch-types";
import {
  extractMistralChatInput,
  extractMistralResponseMetadata,
  normalizeMistralChatChoices,
  parseMistralMetricsFromUsage,
} from "./mistral-span-data";

const BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY = "braintrust.batch_context";
const SUPPORTED_ENDPOINT = "/v1/chat/completions";
const TERMINAL_STATUSES = new Set([
  "SUCCESS",
  "FAILED",
  "TIMEOUT_EXCEEDED",
  "CANCELLED",
]);
const INPUT_DIGEST_CHUNK_SIZE = 1024 * 1024;
const MAX_JSONL_LINE_LENGTH = 16 * 1024 * 1024;
const MAX_CORRELATION_REQUESTS = 100_000;
const MAX_CORRELATION_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 512 * 1024 * 1024;
const MAX_CONTEXT_LENGTH = 2048;
const MAX_RECORDED_ISSUES = 16;

type BatchTarget =
  | { model: string; agentId?: never }
  | { agentId: string; model?: never };

type BatchContextBase = {
  version: 1;
  parent: string;
  inputDigest: string;
  inputKind: "files" | "requests";
  inputFileIds: string[];
  endpoint: string;
  requestCount: number;
  startTime: number;
  operationNonce: string;
};

type BatchContext = BatchContextBase & BatchTarget;

type BatchBindings = Pick<
  BatchContextBase,
  "inputKind" | "inputFileIds" | "endpoint"
> &
  BatchTarget;

type SerializedBatchContext = Pick<
  BatchContextBase,
  | "version"
  | "parent"
  | "inputDigest"
  | "requestCount"
  | "startTime"
  | "operationNonce"
> &
  BatchTarget & { signature: string };

type BatchInputRecord = {
  customId: string;
  ordinal: number;
  spanData?: ReturnType<typeof extractMistralChatInput>;
};

type InputData = {
  inputDigest: string;
  inputs: Map<string, BatchInputRecord>;
  inputKind: BatchContext["inputKind"];
  inputFileIds: string[];
  issues: Error[];
  requestCount: number;
};

type PreparedBatch = {
  context: BatchContext;
  inputs: Map<string, BatchInputRecord>;
  params: MistralBatchCreateParams;
  startParent: string;
};

type CollectOnlyBatch = {
  childStartTime: number;
  context: BatchContext;
  startParent: string;
};

type BatchResultRecord = {
  value: Record<string, unknown>;
  source: "output" | "error";
};

type ResultConsumption = {
  bytes: number;
  limitIssue?: Error;
  records: number;
  maxRecords: number;
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
  debugLogger.debug(`Mistral Batch instrumentation ${context}:`, error);
}

function reportBatchTraceError(
  onTraceError: ((error: Error) => void | Promise<void>) | undefined,
  context: string,
  error: Error,
): void {
  logBatchInstrumentationError(context, error);
  if (!onTraceError) {
    return;
  }
  try {
    void Promise.resolve(onTraceError(error)).catch((callbackError) =>
      logBatchInstrumentationError(
        "trace error callback rejected",
        callbackError,
      ),
    );
  } catch (callbackError) {
    logBatchInstrumentationError("trace error callback threw", callbackError);
  }
}

function recordIssue(issues: Error[], issue: Error): void {
  if (issues.length < MAX_RECORDED_ISSUES) {
    issues.push(issue);
  }
}

function batchContextPayload(context: BatchContext): string {
  return JSON.stringify([BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY, context]);
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

function parseSerializedContext(
  value: unknown,
): SerializedBatchContext | undefined {
  if (typeof value !== "string" || value.length > MAX_CONTEXT_LENGTH) {
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
    !(
      (typeof parsed.model === "string" &&
        parsed.model.length > 0 &&
        parsed.agentId === undefined) ||
      (typeof parsed.agentId === "string" &&
        parsed.agentId.length > 0 &&
        parsed.model === undefined)
    ) ||
    typeof parsed.startTime !== "number" ||
    !Number.isFinite(parsed.startTime) ||
    typeof parsed.requestCount !== "number" ||
    !Number.isInteger(parsed.requestCount) ||
    parsed.requestCount < 0 ||
    parsed.requestCount > MAX_CORRELATION_REQUESTS ||
    typeof parsed.operationNonce !== "string" ||
    !/^[0-9a-f]{32}$/.test(parsed.operationNonce) ||
    typeof parsed.signature !== "string"
  ) {
    return undefined;
  }
  let target: BatchTarget;
  if (typeof parsed.agentId === "string") {
    target = { agentId: parsed.agentId };
  } else if (typeof parsed.model === "string") {
    target = { model: parsed.model };
  } else {
    return undefined;
  }
  return {
    version: 1,
    parent: parsed.parent,
    inputDigest: parsed.inputDigest,
    ...target,
    requestCount: parsed.requestCount,
    startTime: parsed.startTime,
    operationNonce: parsed.operationNonce,
    signature: parsed.signature,
  };
}

async function parseBatchContext(
  value: unknown,
  bindings: BatchBindings,
): Promise<BatchContext | undefined> {
  const parsed = parseSerializedContext(value);
  if (!parsed) {
    return undefined;
  }
  const context: BatchContext = {
    version: 1,
    parent: parsed.parent,
    inputDigest: parsed.inputDigest,
    ...bindings,
    requestCount: parsed.requestCount,
    startTime: parsed.startTime,
    operationNonce: parsed.operationNonce,
  };
  if (parsed.model !== context.model || parsed.agentId !== context.agentId) {
    return undefined;
  }
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

function exportMinimalParent(exported: string): string | undefined {
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

function batchAttachmentKey(
  rowId: string,
  kind: "input" | "output",
  index: number,
): string {
  const [timeLow, timeMid, timeHigh, clockSeq, node] = rowId.split("-");
  const suffix = BigInt(`0x${node}`);
  const domain = kind === "output" ? 1n << 47n : 0n;
  const stableSuffix = (suffix ^ domain ^ BigInt(index + 1))
    .toString(16)
    .padStart(12, "0");
  const variant = ((Number.parseInt(clockSeq[0], 16) & 0x3) | 0x8).toString(16);
  return `${timeLow}-${timeMid}-4${timeHigh.slice(1)}-${variant}${clockSeq.slice(1)}-${stableSuffix}`;
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
    deterministicDigest("mistral:batch:row", operationNonce),
    deterministicDigest("mistral:batch:span", operationNonce),
    deterministicDigest("mistral:batch:root", operationNonce),
  ]);
  return {
    rowId: digestUuid(row),
    spanId: digestHex(span, 8),
    rootSpanId: digestHex(root, 16),
  };
}

async function childSpanIds(operationNonce: string, ordinal: number) {
  const [row, span] = await Promise.all([
    deterministicDigest(
      "mistral:batch:child:row",
      operationNonce,
      String(ordinal),
    ),
    deterministicDigest(
      "mistral:batch:child:span",
      operationNonce,
      String(ordinal),
    ),
  ]);
  return { rowId: digestUuid(row), spanId: digestHex(span, 8) };
}

async function* jsonlRecords(
  file: unknown,
  onIssue: (error: Error) => boolean | void = () => {},
  onBytes?: (bytes: number) => boolean,
): AsyncGenerator<unknown> {
  const reportIssue = (error: Error) => onIssue(error) !== false;
  const resolvedFile = await file;
  if (resolvedFile === undefined) {
    return;
  }
  if (typeof resolvedFile === "string") {
    let offset = 0;
    while (offset < resolvedFile.length) {
      const newline = resolvedFile.indexOf("\n", offset);
      const end = newline === -1 ? resolvedFile.length : newline;
      const rawLine = resolvedFile.slice(offset, end);
      offset = newline === -1 ? resolvedFile.length : newline + 1;
      if (
        onBytes &&
        !onBytes(utf8ByteLength(rawLine) + (newline === -1 ? 0 : 1))
      ) {
        return;
      }
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim()) {
        continue;
      }
      if (line.length > MAX_JSONL_LINE_LENGTH) {
        if (
          !reportIssue(
            new Error("Mistral Batch JSONL line exceeds the tracing limit"),
          )
        ) {
          return;
        }
        continue;
      }
      try {
        yield JSON.parse(line);
      } catch (error) {
        logBatchInstrumentationError("skipped malformed JSONL", error);
        if (
          !reportIssue(new Error("Mistral Batch file contains malformed JSONL"))
        ) {
          return;
        }
      }
    }
    return;
  }

  const body = read(resolvedFile, "body");
  const stream = isObject(body) ? body : resolvedFile;
  const getReader = read(stream, "getReader");
  if (isObject(stream) && typeof getReader === "function") {
    let reader: unknown;
    let reachedEof = false;
    try {
      reader = Reflect.apply(getReader, stream, []);
      if (!isObject(reader)) {
        throw new Error("Batch stream returned an invalid reader");
      }

      const decoder = new TextDecoder();
      let pending = "";
      let overLimit = false;
      while (true) {
        const readChunk = read(reader, "read");
        if (typeof readChunk !== "function") {
          throw new Error("Batch stream reader has no read method");
        }
        const chunk = await Reflect.apply(readChunk, reader, []);
        if (!isObject(chunk)) {
          throw new Error("Batch stream returned an invalid chunk");
        }
        if (chunk.done === true) {
          reachedEof = true;
          pending += decoder.decode();
          break;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("Batch stream returned a non-byte chunk");
        }
        if (onBytes && !onBytes(chunk.value.byteLength)) {
          return;
        }

        pending += decoder.decode(chunk.value, { stream: true });
        if (pending.length > MAX_JSONL_LINE_LENGTH && !pending.includes("\n")) {
          pending = "";
          overLimit = true;
          if (
            !reportIssue(
              new Error("Mistral Batch JSONL line exceeds the tracing limit"),
            )
          ) {
            return;
          }
        }
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/, "");
          pending = pending.slice(newline + 1);
          if (overLimit) {
            overLimit = false;
          } else if (line.trim()) {
            if (line.length > MAX_JSONL_LINE_LENGTH) {
              if (
                !reportIssue(
                  new Error(
                    "Mistral Batch JSONL line exceeds the tracing limit",
                  ),
                )
              ) {
                return;
              }
            } else {
              try {
                yield JSON.parse(line);
              } catch (error) {
                logBatchInstrumentationError("skipped malformed JSONL", error);
                if (
                  !reportIssue(
                    new Error(
                      "Mistral Batch response contains malformed JSONL",
                    ),
                  )
                ) {
                  return;
                }
              }
            }
          }
          newline = pending.indexOf("\n");
        }
      }

      if (!overLimit && pending.trim()) {
        if (pending.length > MAX_JSONL_LINE_LENGTH) {
          if (
            !reportIssue(
              new Error("Mistral Batch JSONL line exceeds the tracing limit"),
            )
          ) {
            return;
          }
        } else {
          try {
            yield JSON.parse(pending.replace(/\r$/, ""));
          } catch (error) {
            logBatchInstrumentationError("skipped malformed JSONL", error);
            if (
              !reportIssue(
                new Error("Mistral Batch response contains malformed JSONL"),
              )
            ) {
              return;
            }
          }
        }
      }
    } catch (error) {
      logBatchInstrumentationError("could not read JSONL stream", error);
      reportIssue(new Error("Mistral Batch stream could not be read"));
    } finally {
      const cancel = read(reader, "cancel");
      if (!reachedEof && isObject(reader) && typeof cancel === "function") {
        try {
          await Reflect.apply(cancel, reader, []);
        } catch (error) {
          logBatchInstrumentationError("could not cancel JSONL stream", error);
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
    for await (const record of resolvedFile) {
      if (onBytes) {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(record);
        } catch (error) {
          logBatchInstrumentationError("could not measure JSONL record", error);
        }
        if (serialized === undefined) {
          if (
            !reportIssue(
              new Error("Mistral Batch result contains a non-JSON record"),
            )
          ) {
            return;
          }
          continue;
        }
        if (!onBytes(utf8ByteLength(serialized))) {
          return;
        }
      }
      yield record;
    }
  } else {
    logBatchInstrumentationError("skipped invalid JSONL source", resolvedFile);
    reportIssue(new Error("Mistral Batch file source is invalid"));
  }
}

async function readBatchInputs(input: MistralBatchInput): Promise<InputData> {
  const inputs = new Map<string, BatchInputRecord>();
  const issues: Error[] = [];
  const inputKind = "files" in input ? "files" : "requests";
  const inputFileIds =
    "files" in input ? input.files.map(({ file }) => file.id) : [];
  const chunkDigests: string[] = [];
  let correlationBytes = 0;
  let digestChunk = "";

  const addRecord = async (value: unknown): Promise<boolean> => {
    const customId =
      inputKind === "files"
        ? read(value, "custom_id")
        : read(value, "customId");
    const body = read(value, "body");
    if (!validCustomId(customId) || inputs.has(customId) || !isObject(body)) {
      recordIssue(
        issues,
        new Error("Mistral Batch input contains an invalid record"),
      );
      return false;
    }
    if (inputs.size >= MAX_CORRELATION_REQUESTS) {
      recordIssue(
        issues,
        new Error("Mistral Batch input exceeds the correlation record limit"),
      );
      return false;
    }

    let canonicalRecord: string;
    try {
      const serializedRecord = JSON.stringify(
        { body, custom_id: customId },
        deterministicReplacer,
      );
      if (serializedRecord === undefined) {
        throw new Error("Mistral Batch input could not be serialized");
      }
      canonicalRecord = serializedRecord;
    } catch (error) {
      recordIssue(
        issues,
        error instanceof Error
          ? error
          : new Error("Mistral Batch input could not be canonicalized"),
      );
      return false;
    }
    const canonicalBytes = utf8ByteLength(canonicalRecord);
    if (
      canonicalBytes > MAX_JSONL_LINE_LENGTH ||
      correlationBytes + canonicalBytes > MAX_CORRELATION_BYTES
    ) {
      recordIssue(
        issues,
        new Error("Mistral Batch input exceeds the correlation byte limit"),
      );
      return false;
    }
    correlationBytes += canonicalBytes;
    const framedRecord = `${canonicalRecord.length}:${canonicalRecord}`;
    if (
      digestChunk.length > 0 &&
      digestChunk.length + framedRecord.length > INPUT_DIGEST_CHUNK_SIZE
    ) {
      chunkDigests.push(
        digestHex(
          await deterministicDigest("mistral:batch:input:chunk", digestChunk),
          32,
        ),
      );
      digestChunk = "";
    }
    digestChunk += framedRecord;

    let spanData: BatchInputRecord["spanData"];
    try {
      spanData = extractMistralChatInput(body, { processAttachments: false });
    } catch (error) {
      logBatchInstrumentationError("could not extract batch input", error);
    }
    inputs.set(customId, { customId, ordinal: inputs.size, spanData });
    return true;
  };

  try {
    if ("files" in input) {
      if (
        input.files.length === 0 ||
        inputFileIds.some((id) => typeof id !== "string" || id.length === 0) ||
        new Set(inputFileIds).size !== inputFileIds.length
      ) {
        recordIssue(
          issues,
          new Error("Mistral Batch input contains invalid files"),
        );
      }
      if (issues.length === 0) {
        fileLoop: for (const { content } of input.files) {
          const source = typeof content === "function" ? content() : content;
          for await (const value of jsonlRecords(source, (issue) => {
            recordIssue(issues, issue);
            return false;
          })) {
            if (!(await addRecord(value))) {
              break fileLoop;
            }
          }
        }
      }
    } else {
      for (const value of input.requests) {
        if (!(await addRecord(value))) {
          break;
        }
      }
    }
  } catch (error) {
    logBatchInstrumentationError("could not process batch input", error);
    recordIssue(
      issues,
      new Error("Mistral Batch input could not be processed"),
    );
  }

  chunkDigests.push(
    digestHex(
      await deterministicDigest("mistral:batch:input:chunk", digestChunk),
      32,
    ),
  );
  return {
    inputDigest: digestHex(
      await deterministicDigest("mistral:batch:input", chunkDigests.join("")),
      32,
    ),
    inputs,
    inputKind,
    inputFileIds,
    issues,
    requestCount: inputs.size,
  };
}

function providerReadyParams(
  args: StartMistralBatchTraceArgs,
): MistralBatchCreateParams {
  return "files" in args.input
    ? {
        ...args.params,
        inputFiles: args.input.files.map(({ file }) => file.id),
      }
    : { ...args.params, requests: [...args.input.requests] };
}

async function prepareCreateParams(
  args: StartMistralBatchTraceArgs,
  parent: ReturnType<typeof getSpanParentObject>,
  startTime: number,
): Promise<PreparedBatch | undefined> {
  const params = providerReadyParams(args);
  const endpoint = read(params, "endpoint");
  const model = read(params, "model");
  const agentId = read(params, "agentId");
  const validModel = typeof model === "string" && model.length > 0;
  const validAgentId = typeof agentId === "string" && agentId.length > 0;
  if (endpoint !== SUPPORTED_ENDPOINT || validModel === validAgentId) {
    return undefined;
  }
  let target: BatchTarget;
  if (validAgentId && typeof agentId === "string") {
    target = { agentId };
  } else if (validModel && typeof model === "string") {
    target = { model };
  } else {
    return undefined;
  }

  const metadataValue = read(params, "metadata");
  if (
    metadataValue !== undefined &&
    metadataValue !== null &&
    (!isObject(metadataValue) || Array.isArray(metadataValue))
  ) {
    reportBatchTraceError(
      args.onTraceError,
      "skipped context injection",
      new Error("Mistral Batch metadata is invalid"),
    );
    return undefined;
  }
  const metadata = metadataValue ?? {};
  if (
    Object.prototype.hasOwnProperty.call(
      metadata,
      BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY,
    )
  ) {
    reportBatchTraceError(
      args.onTraceError,
      "skipped context injection",
      new Error("Mistral Batch metadata contains a reserved tracing key"),
    );
    return undefined;
  }

  const startParent = await exportParent(parent);
  const serializedParent = exportMinimalParent(startParent);
  if (!serializedParent) {
    reportBatchTraceError(
      args.onTraceError,
      "skipped context injection",
      new Error("Mistral Batch tracing has no routable Braintrust parent"),
    );
    return undefined;
  }
  const signingSecret =
    _internalGetGlobalState()._internalGetTraceContextSigningSecret();
  if (!signingSecret) {
    reportBatchTraceError(
      args.onTraceError,
      "skipped context injection",
      new Error("Mistral Batch tracing has no signing secret"),
    );
    return undefined;
  }

  const inputData = await readBatchInputs(args.input);
  if (inputData.issues.length > 0) {
    reportBatchTraceError(
      args.onTraceError,
      "skipped invalid batch input",
      inputData.issues[0],
    );
    return undefined;
  }
  const context: BatchContext = {
    version: 1,
    parent: serializedParent,
    inputDigest: inputData.inputDigest,
    inputKind: inputData.inputKind,
    inputFileIds: inputData.inputFileIds,
    endpoint,
    ...target,
    requestCount: inputData.requestCount,
    startTime,
    operationNonce: randomBatchNonce(),
  };
  const signature = await signBatchContext(context, signingSecret);
  if (!signature) {
    reportBatchTraceError(
      args.onTraceError,
      "skipped context injection",
      new Error("Mistral Batch tracing context could not be signed"),
    );
    return undefined;
  }
  const serialized = JSON.stringify({
    version: context.version,
    parent: context.parent,
    inputDigest: context.inputDigest,
    ...target,
    requestCount: context.requestCount,
    startTime: context.startTime,
    operationNonce: context.operationNonce,
    signature,
  } satisfies SerializedBatchContext);
  if (serialized.length > MAX_CONTEXT_LENGTH) {
    reportBatchTraceError(
      args.onTraceError,
      "skipped context injection",
      new Error("Mistral Batch tracing context exceeds the tracing limit"),
    );
    return undefined;
  }

  return {
    context,
    inputs: inputData.inputs,
    startParent,
    params: {
      ...params,
      metadata: {
        ...metadata,
        [BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY]: serialized,
      },
    },
  };
}

async function startBatchSpan(
  context: BatchContext,
  startParent = context.parent,
): Promise<Span> {
  const ids = await batchSpanIds(context.operationNonce);
  const parent = SpanComponentsV4.fromStr(startParent);
  const hasParentSpan = Boolean(
    parent.data.row_id && parent.data.span_id && parent.data.root_span_id,
  );
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMergeAndParentSpanIds(
      withSpanInstrumentationName(
        {
          name: "mistral.batch",
          type: SpanTypeAttribute.TASK,
          parent: parent.toStr(),
          parentSpanIds: hasParentSpan
            ? {
                spanId: parent.data.span_id ?? "",
                rootSpanId: parent.data.root_span_id ?? "",
              }
            : {
                parentSpanIds: [],
                rootSpanId: ids.rootSpanId,
              },
          spanId: ids.spanId,
          startTime: context.startTime,
          event: {
            id: ids.rowId,
            metadata: { provider: "mistral" },
          },
        },
        INSTRUMENTATION_NAMES.MISTRAL,
      ),
    ),
  );
}

async function resumeBatchSpan(context: BatchContext): Promise<Span> {
  const ids = await batchSpanIds(context.operationNonce);
  const parent = SpanComponentsV4.fromStr(context.parent).data;
  const routing = parent.object_id
    ? { object_id: parent.object_id }
    : {
        compute_object_metadata_args: parent.compute_object_metadata_args ?? {},
      };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const exported = new SpanComponentsV4({
    object_type: parent.object_type,
    ...routing,
    row_id: ids.rowId,
    span_id: ids.spanId,
    root_span_id: parent.root_span_id ?? ids.rootSpanId,
  } as SpanComponentsV4Data).toStr();
  return _internalResumeSpan({
    exported,
    spanParents: parent.span_id ? [parent.span_id] : [],
  });
}

async function startBatchChild(
  context: BatchContext,
  taskParent: string,
  input: BatchInputRecord,
  startTime = context.startTime,
): Promise<Span> {
  const ids = await childSpanIds(context.operationNonce, input.ordinal);
  const spanInput =
    input.spanData?.input === undefined
      ? undefined
      : processInputAttachments(input.spanData.input, {
          attachmentKey: (index) =>
            batchAttachmentKey(ids.rowId, "input", index),
        });
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMerge(
      withSpanInstrumentationName(
        {
          name: "mistral.chat.complete",
          type: SpanTypeAttribute.LLM,
          parent: taskParent,
          spanId: ids.spanId,
          startTime,
          event: {
            id: ids.rowId,
            ...(spanInput !== undefined ? { input: spanInput } : {}),
            metadata: {
              ...input.spanData?.metadata,
              ...(context.model ? { model: context.model } : {}),
              ...(context.agentId ? { agent_id: context.agentId } : {}),
              provider: "mistral",
            },
          },
        },
        INSTRUMENTATION_NAMES.MISTRAL,
      ),
    ),
  );
}

async function resumeBatchChild(
  context: BatchContext,
  taskParent: string,
  input: BatchInputRecord,
): Promise<Span> {
  const ids = await childSpanIds(context.operationNonce, input.ordinal);
  const task = SpanComponentsV4.fromStr(taskParent).data;
  if (!task.span_id || !task.root_span_id) {
    throw new Error("Mistral Batch task span cannot be resumed");
  }
  const routing = task.object_id
    ? { object_id: task.object_id }
    : {
        compute_object_metadata_args: task.compute_object_metadata_args ?? {},
      };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const exported = new SpanComponentsV4({
    object_type: task.object_type,
    ...routing,
    row_id: ids.rowId,
    span_id: ids.spanId,
    root_span_id: task.root_span_id,
  } as SpanComponentsV4Data).toStr();
  return _internalResumeSpan({ exported, spanParents: [task.span_id] });
}

async function startPreparedBatch(prepared: PreparedBatch): Promise<void> {
  const { context, inputs, startParent } = prepared;
  let task: Span | undefined;
  let taskParent: string | undefined;
  let startedChildCount = 0;
  try {
    task = await startBatchSpan(context, startParent);
    taskParent = await task.export();
    for (const input of inputs.values()) {
      await startBatchChild(context, taskParent, input);
      startedChildCount++;
    }
  } catch (error) {
    const initializationError =
      error instanceof Error
        ? error
        : new Error("Mistral Batch tracing could not start spans");
    const endTime = Math.max(getCurrentUnixTimestamp(), context.startTime);
    for (let ordinal = startedChildCount - 1; ordinal >= 0; ordinal--) {
      try {
        if (!taskParent) {
          break;
        }
        const child = await resumeBatchChild(context, taskParent, {
          customId: `startup-rollback-${ordinal}`,
          ordinal,
        });
        child.log({ error: initializationError });
        child.end({ endTime });
      } catch (cleanupError) {
        logBatchInstrumentationError(
          "could not roll back an initialized child",
          cleanupError,
        );
      }
    }
    if (task) {
      try {
        task.log({ error: initializationError });
        task.end({ endTime });
      } catch (cleanupError) {
        logBatchInstrumentationError(
          "could not roll back the initialized task",
          cleanupError,
        );
      }
    }
    throw initializationError;
  }
}

export async function startMistralBatchTraceImpl(
  args: StartMistralBatchTraceArgs,
): Promise<MistralBatchCreateParams> {
  const parent = getSpanParentObject();
  const startTime = getCurrentUnixTimestamp();
  let prepared: PreparedBatch | undefined;
  try {
    prepared = await prepareCreateParams(args, parent, startTime);
  } catch (error) {
    reportBatchTraceError(
      args.onTraceError,
      "could not prepare batch",
      error instanceof Error
        ? error
        : new Error("Mistral Batch tracing could not prepare the batch"),
    );
  }

  if (!prepared) {
    return providerReadyParams(args);
  }
  try {
    await startPreparedBatch(prepared);
    return prepared.params;
  } catch (error) {
    reportBatchTraceError(
      args.onTraceError,
      "could not start batch spans",
      error instanceof Error
        ? error
        : new Error("Mistral Batch tracing could not start spans"),
    );
    return providerReadyParams(args);
  }
}

function errorFromResult(result: BatchResultRecord): Error | undefined {
  const error = read(result.value, "error");
  if (isObject(error)) {
    const message = read(error, "message");
    return new Error(
      typeof message === "string" ? message : "Mistral Batch request failed",
    );
  }
  const response = read(result.value, "response");
  const statusCode =
    read(response, "status_code") ?? read(response, "statusCode");
  if (
    result.source === "error" ||
    (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300))
  ) {
    const body = read(response, "body");
    const bodyError = read(body, "error");
    const message = read(bodyError, "message") ?? read(body, "message");
    return new Error(
      typeof message === "string" ? message : "Mistral Batch request failed",
    );
  }
  return undefined;
}

async function completeBatchResult({
  childStartTime,
  context,
  endTime,
  initializedOrdinals,
  input,
  result,
  resumeExistingSpans,
  taskParent,
}: {
  childStartTime: number;
  context: BatchContext;
  endTime: number;
  initializedOrdinals: Set<number>;
  input: BatchInputRecord;
  result: BatchResultRecord;
  resumeExistingSpans: boolean;
  taskParent: string;
}): Promise<boolean> {
  const child =
    resumeExistingSpans || initializedOrdinals.has(input.ordinal)
      ? await resumeBatchChild(context, taskParent, input)
      : await startBatchChild(context, taskParent, input, childStartTime);
  if (!resumeExistingSpans && !initializedOrdinals.has(input.ordinal)) {
    initializedOrdinals.add(input.ordinal);
  }
  try {
    const resultError = errorFromResult(result);
    const response = read(result.value, "response");
    const responseBody = read(response, "body");
    if (resultError) {
      child.log({ error: resultError });
    } else if (isObject(responseBody)) {
      const choices = normalizeMistralChatChoices(
        read(responseBody, "choices"),
      );
      if (!choices) {
        return false;
      }
      child.log({
        output: processInputAttachments(choices, {
          attachmentKey: (index) =>
            batchAttachmentKey(child.id, "output", index),
        }),
        metadata: extractMistralResponseMetadata(responseBody),
        metrics: parseMistralMetricsFromUsage(read(responseBody, "usage")),
      });
    } else {
      return false;
    }
    child.end({ endTime });
    return true;
  } catch (error) {
    logBatchInstrumentationError("could not complete batch child", error);
    return false;
  }
}

function batchBindings(
  inputData: InputData,
  endpoint: unknown,
  model: unknown,
  agentId: unknown,
): BatchBindings | undefined {
  if (endpoint !== SUPPORTED_ENDPOINT) {
    return undefined;
  }
  let target: BatchTarget;
  if (typeof agentId === "string" && agentId.length > 0) {
    target = { agentId };
  } else if (typeof model === "string" && model.length > 0) {
    target = { model };
  } else {
    return undefined;
  }
  return {
    inputKind: inputData.inputKind,
    inputFileIds: inputData.inputFileIds,
    endpoint,
    ...target,
  };
}

function hasReservedContext(metadata: unknown): boolean {
  return (
    isObject(metadata) &&
    Object.prototype.hasOwnProperty.call(
      metadata,
      BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY,
    )
  );
}

async function signedContextFromBatch(
  batch: MistralBatchLike,
  inputData: InputData,
): Promise<BatchContext | undefined> {
  const metadata = read(batch, "metadata");
  const serialized = parseSerializedContext(
    read(metadata, BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY),
  );
  const providerModel = read(batch, "model");
  const providerAgentId = read(batch, "agentId");
  if (
    !serialized ||
    (serialized.agentId &&
      typeof providerAgentId === "string" &&
      providerAgentId !== serialized.agentId) ||
    (serialized.model &&
      typeof providerModel === "string" &&
      providerModel !== serialized.model)
  ) {
    return undefined;
  }
  const bindings = batchBindings(
    inputData,
    read(batch, "endpoint"),
    serialized.model,
    serialized.agentId,
  );
  if (!bindings || !hasReservedContext(metadata)) {
    return undefined;
  }
  return await parseBatchContext(
    read(metadata, BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY),
    bindings,
  );
}

function validProviderTime(value: unknown, minimum = 0): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? value
    : undefined;
}

async function collectOnlyContext(
  batch: MistralBatchLike,
  inputData: InputData,
  parentObject: ReturnType<typeof getSpanParentObject> | string,
  collectionTime: number,
): Promise<CollectOnlyBatch | undefined> {
  const bindings = batchBindings(
    inputData,
    read(batch, "endpoint"),
    read(batch, "model"),
    read(batch, "agentId"),
  );
  const batchId = read(batch, "id");
  if (!bindings || typeof batchId !== "string" || !batchId) {
    return undefined;
  }
  const startParent =
    typeof parentObject === "string"
      ? parentObject
      : await exportParent(parentObject);
  const serializedParent = exportMinimalParent(startParent);
  if (!serializedParent) {
    return undefined;
  }
  const createdAt = validProviderTime(read(batch, "createdAt"));
  const startTime =
    createdAt !== undefined && createdAt <= collectionTime
      ? createdAt
      : collectionTime;
  const startedAt = validProviderTime(read(batch, "startedAt"), startTime);
  const childStartTime =
    startedAt !== undefined && startedAt <= collectionTime
      ? startedAt
      : startTime;
  const nonce = await deterministicDigest(
    "mistral:batch:collect-only",
    batchId,
    bindings.endpoint,
    bindings.agentId ? "agent" : "model",
    bindings.agentId ?? bindings.model,
    inputData.inputDigest,
    serializedParent,
  );
  return {
    childStartTime,
    startParent,
    context: {
      version: 1,
      parent: serializedParent,
      inputDigest: inputData.inputDigest,
      requestCount: inputData.requestCount,
      ...bindings,
      startTime,
      operationNonce: digestHex(nonce, 16),
    },
  };
}

function terminalEndTime(batch: MistralBatchLike, startTime: number): number {
  return (
    validProviderTime(read(batch, "completedAt"), startTime) ??
    Math.max(getCurrentUnixTimestamp(), startTime)
  );
}

async function completeResultFile({
  childStartTime,
  context,
  endTime,
  file,
  completedOrdinals,
  initializedOrdinals,
  consumption,
  inputs,
  issues,
  resumeExistingSpans,
  source,
  taskParent,
}: {
  childStartTime: number;
  context: BatchContext;
  endTime: number;
  file: unknown;
  completedOrdinals: Set<number>;
  initializedOrdinals: Set<number>;
  consumption: ResultConsumption;
  inputs: Map<string, BatchInputRecord>;
  issues: Error[];
  resumeExistingSpans: boolean;
  source: BatchResultRecord["source"];
  taskParent: string;
}): Promise<void> {
  if (inputs.size === 0) {
    return;
  }
  try {
    for await (const value of jsonlRecords(
      file,
      (issue) => recordIssue(issues, issue),
      (bytes) => {
        if (consumption.bytes + bytes > MAX_RESULT_BYTES) {
          consumption.limitIssue = new Error(
            "Mistral Batch results exceed the tracing byte limit",
          );
          recordIssue(issues, consumption.limitIssue);
          return false;
        }
        consumption.bytes += bytes;
        return true;
      },
    )) {
      if (consumption.records >= consumption.maxRecords) {
        consumption.limitIssue = new Error(
          "Mistral Batch results exceed the tracing record limit",
        );
        recordIssue(issues, consumption.limitIssue);
        return;
      }
      consumption.records++;
      try {
        const customId = read(value, "custom_id") ?? read(value, "customId");
        if (!validCustomId(customId) || !isObject(value)) {
          recordIssue(
            issues,
            new Error("Mistral Batch result is missing a valid custom id"),
          );
          continue;
        }
        const input = inputs.get(customId);
        if (!input) {
          recordIssue(
            issues,
            new Error("Mistral Batch result does not match an input record"),
          );
          continue;
        }
        const completed = await completeBatchResult({
          childStartTime,
          context,
          endTime,
          initializedOrdinals,
          input,
          result: {
            value,
            source,
          },
          resumeExistingSpans,
          taskParent,
        });
        if (!completed) {
          recordIssue(
            issues,
            new Error("Mistral Batch result contains an invalid response"),
          );
          continue;
        }
        completedOrdinals.add(input.ordinal);
        inputs.delete(customId);
        if (inputs.size === 0) {
          return;
        }
      } catch (error) {
        logBatchInstrumentationError("skipped invalid result", error);
        recordIssue(
          issues,
          new Error("Mistral Batch result could not be processed"),
        );
      }
    }
  } catch (error) {
    logBatchInstrumentationError(`could not process ${source} file`, error);
    recordIssue(
      issues,
      new Error(`Mistral Batch ${source} file could not be processed`),
    );
  }
}

function sameStrings(left: unknown, right: string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function completeBatch(
  args: CompleteMistralBatchTraceArgs<MistralBatchLike>,
  parent: ReturnType<typeof getSpanParentObject>,
  collectionTime: number,
): Promise<void> {
  const { batch } = args;
  const batchId = read(batch, "id");
  const status = read(batch, "status");
  if (
    typeof batchId !== "string" ||
    typeof status !== "string" ||
    !TERMINAL_STATUSES.has(status)
  ) {
    return;
  }

  const inputData = await readBatchInputs(args.input);
  const metadata = read(batch, "metadata");
  let context: BatchContext | undefined;
  let childStartTime: number | undefined;
  let startParent: string | undefined;
  let resumedSignedContext = false;
  if (hasReservedContext(metadata)) {
    context = await signedContextFromBatch(batch, inputData);
    resumedSignedContext = context !== undefined;
    if (!resumedSignedContext) {
      reportBatchTraceError(
        args.onTraceError,
        "ignored invalid signed context",
        new Error("Mistral Batch tracing context verification failed"),
      );
    }
  }
  if (!context && inputData.issues.length === 0) {
    const collectOnly = await collectOnlyContext(
      batch,
      inputData,
      args.collectionContext?.value ?? parent,
      collectionTime,
    );
    context = collectOnly?.context;
    childStartTime = collectOnly?.childStartTime;
    startParent = collectOnly?.startParent;
  }
  if (!context) {
    if (inputData.issues.length > 0) {
      reportBatchTraceError(
        args.onTraceError,
        "could not reconstruct batch input",
        inputData.issues[0],
      );
    }
    return;
  }

  const isSuccessful = status === "SUCCESS";
  const isCollectOnly = !resumedSignedContext;
  const requiresCompleteIntegrity = isSuccessful || isCollectOnly;
  const integrityIssues = [...inputData.issues];
  if (resumedSignedContext && inputData.inputDigest !== context.inputDigest) {
    integrityIssues.push(
      new Error("Mistral Batch input does not match the signed input"),
    );
  }
  const batchInputFiles = read(batch, "inputFiles");
  if (
    inputData.inputKind === "files" &&
    !sameStrings(batchInputFiles, inputData.inputFileIds)
  ) {
    integrityIssues.push(
      new Error("Mistral Batch input files do not match the batch input"),
    );
  }
  const totalRequests = read(batch, "totalRequests");
  const requestCountMismatch = resumedSignedContext
    ? typeof totalRequests === "number" &&
      totalRequests !== inputData.requestCount
    : totalRequests !== inputData.requestCount;
  if (requestCountMismatch) {
    const issue = new Error(
      "Mistral Batch input does not match its request count",
    );
    if (requiresCompleteIntegrity) {
      integrityIssues.push(issue);
    } else {
      logBatchInstrumentationError(
        "completed terminal batch despite request count mismatch",
        issue,
      );
    }
  }
  if (integrityIssues.length > 0) {
    let diagnosticContext: string;
    if (isCollectOnly) {
      diagnosticContext =
        "skipped collect-only batch with incomplete correlation";
    } else if (isSuccessful) {
      diagnosticContext = "left batch spans pending";
    } else {
      diagnosticContext =
        "completed terminal batch with incomplete correlation";
    }
    reportBatchTraceError(
      args.onTraceError,
      diagnosticContext,
      integrityIssues[0],
    );
    if (requiresCompleteIntegrity) {
      return;
    }
  }

  const resolvedChildStartTime = childStartTime ?? context.startTime;
  const endTime = terminalEndTime(
    batch,
    Math.max(context.startTime, resolvedChildStartTime),
  );
  const task = resumedSignedContext
    ? await resumeBatchSpan(context)
    : await startBatchSpan(context, startParent);
  const taskParent = await task.export();
  const issues: Error[] = [];
  const completedOrdinals = new Set<number>();
  const initializedOrdinals = new Set<number>();
  const consumption: ResultConsumption = {
    bytes: 0,
    records: 0,
    maxRecords: Math.min(
      MAX_CORRELATION_REQUESTS,
      context.requestCount + MAX_RECORDED_ISSUES,
    ),
  };
  const canProcessResults =
    integrityIssues.length === 0 ||
    (!isSuccessful &&
      resumedSignedContext &&
      (inputData.issues.length > 0 ||
        inputData.inputDigest === context.inputDigest));
  if (canProcessResults) {
    await completeResultFile({
      childStartTime: resolvedChildStartTime,
      context,
      endTime,
      file: args.outputContent ?? read(batch, "outputs"),
      completedOrdinals,
      initializedOrdinals,
      consumption,
      inputs: inputData.inputs,
      issues,
      resumeExistingSpans: resumedSignedContext,
      source: "output",
      taskParent,
    });
    await completeResultFile({
      childStartTime: resolvedChildStartTime,
      context,
      endTime,
      file: args.errorContent,
      completedOrdinals,
      initializedOrdinals,
      consumption,
      inputs: inputData.inputs,
      issues,
      resumeExistingSpans: resumedSignedContext,
      source: "error",
      taskParent,
    });
  }

  if (isSuccessful && inputData.inputs.size > 0) {
    if (isCollectOnly) {
      for (const input of inputData.inputs.values()) {
        if (initializedOrdinals.has(input.ordinal)) {
          continue;
        }
        try {
          await startBatchChild(
            context,
            taskParent,
            input,
            resolvedChildStartTime,
          );
          initializedOrdinals.add(input.ordinal);
        } catch (error) {
          logBatchInstrumentationError(
            "could not start pending collect-only child",
            error,
          );
          recordIssue(
            issues,
            new Error("Mistral Batch pending child could not be initialized"),
          );
        }
      }
    }
    reportBatchTraceError(
      args.onTraceError,
      "left batch spans pending",
      consumption.limitIssue ??
        issues[0] ??
        new Error("Mistral Batch results are incomplete"),
    );
    return;
  }

  if (issues.length > 0) {
    reportBatchTraceError(
      args.onTraceError,
      "ignored invalid batch result records",
      issues[0],
    );
  }

  const statusError = new Error(`Mistral Batch ${status}`);
  const remainingByOrdinal = new Map(
    [...inputData.inputs.values()].map((input) => [input.ordinal, input]),
  );
  const closureCount =
    isSuccessful || isCollectOnly
      ? inputData.requestCount
      : context.requestCount;
  for (let ordinal = 0; ordinal < closureCount; ordinal++) {
    if (completedOrdinals.has(ordinal)) {
      continue;
    }
    const input = remainingByOrdinal.get(ordinal) ?? {
      customId: `unresolved-${ordinal}`,
      ordinal,
    };
    try {
      const child =
        resumedSignedContext || initializedOrdinals.has(input.ordinal)
          ? await resumeBatchChild(context, taskParent, input)
          : await startBatchChild(
              context,
              taskParent,
              input,
              resolvedChildStartTime,
            );
      child.log({ error: statusError });
      child.end({ endTime });
    } catch (error) {
      logBatchInstrumentationError("could not complete missing result", error);
    }
  }

  if (!isSuccessful) {
    task.log({ error: statusError });
  }
  task.end({ endTime });
}

export async function completeMistralBatchTraceImpl<
  TBatch extends MistralBatchLike,
>(
  args: CompleteMistralBatchTraceArgs<TBatch>,
  parent: ReturnType<typeof getSpanParentObject>,
): Promise<MistralBatchTraceCollection<TBatch>> {
  const collectionTime = getCurrentUnixTimestamp();
  const suppliedCollectionContext = args.collectionContext;
  let collectionContext: MistralBatchCollectionContext | undefined;
  if (suppliedCollectionContext) {
    if (
      read(suppliedCollectionContext, "version") === 1 &&
      typeof read(suppliedCollectionContext, "value") === "string"
    ) {
      collectionContext = suppliedCollectionContext;
    } else {
      reportBatchTraceError(
        args.onTraceError,
        "ignored invalid collection context",
        new Error("Mistral Batch collection context is invalid"),
      );
    }
  }
  if (!collectionContext) {
    try {
      collectionContext = { version: 1, value: await exportParent(parent) };
    } catch (error) {
      reportBatchTraceError(
        args.onTraceError,
        "could not create collection context",
        error instanceof Error
          ? error
          : new Error("Mistral Batch collection context could not be created"),
      );
    }
  }
  try {
    await completeBatch(
      { ...args, ...(collectionContext ? { collectionContext } : {}) },
      parent,
      collectionTime,
    );
  } catch (error) {
    reportBatchTraceError(
      args.onTraceError,
      "could not complete batch",
      error instanceof Error
        ? error
        : new Error("Mistral Batch tracing could not complete the batch"),
    );
  }
  return {
    batch: args.batch,
    ...(collectionContext ? { collectionContext } : {}),
  };
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" ? error : "Mistral Batch failed");
}

async function failBatch(args: FailMistralBatchTraceArgs): Promise<void> {
  const inputData = await readBatchInputs(args.input);
  if (inputData.issues.length > 0) {
    reportBatchTraceError(
      args.onTraceError,
      "could not reconstruct failed batch input",
      inputData.issues[0],
    );
    return;
  }
  const metadata = read(args.params, "metadata");
  const bindings = batchBindings(
    inputData,
    read(args.params, "endpoint"),
    read(args.params, "model"),
    read(args.params, "agentId"),
  );
  if (!bindings || !hasReservedContext(metadata)) {
    return;
  }
  const context = await parseBatchContext(
    read(metadata, BRAINTRUST_MISTRAL_BATCH_CONTEXT_KEY),
    bindings,
  );
  if (!context || context.inputDigest !== inputData.inputDigest) {
    reportBatchTraceError(
      args.onTraceError,
      "could not verify failed batch context",
      new Error("Mistral Batch tracing context does not match the input"),
    );
    return;
  }
  if (
    inputData.inputKind === "files" &&
    !sameStrings(read(args.params, "inputFiles"), inputData.inputFileIds)
  ) {
    reportBatchTraceError(
      args.onTraceError,
      "could not verify failed batch files",
      new Error("Mistral Batch tracing file ids do not match the input"),
    );
    return;
  }

  const endTime = Math.max(getCurrentUnixTimestamp(), context.startTime);
  const error = normalizeError(args.error);
  const task = await resumeBatchSpan(context);
  const taskParent = await task.export();
  for (const input of inputData.inputs.values()) {
    try {
      const child = await resumeBatchChild(context, taskParent, input);
      child.log({ error });
      child.end({ endTime });
    } catch (spanError) {
      logBatchInstrumentationError("could not fail batch child", spanError);
    }
  }
  task.log({ error });
  task.end({ endTime });
}

export async function failMistralBatchTraceImpl(
  args: FailMistralBatchTraceArgs,
): Promise<void> {
  try {
    await failBatch(args);
  } catch (error) {
    reportBatchTraceError(
      args.onTraceError,
      "could not fail batch",
      error instanceof Error
        ? error
        : new Error("Mistral Batch tracing could not fail the batch"),
    );
  }
}
