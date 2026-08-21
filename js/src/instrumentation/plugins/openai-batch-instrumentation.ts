import { debugLogger } from "../../debug-logger";
import {
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
import { isObject, SpanTypeAttribute } from "../../../util/index";
import { SpanComponentsV4 } from "../../../util/span_identifier_v4";
import type {
  CompleteOpenAIBatchTraceArgs,
  OpenAIBatchFile,
  OpenAIBatchLike,
} from "../../openai-batch-types";
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

type BatchInputRecord = {
  customId: string;
  spanData?: ReturnType<typeof extractOpenAIBatchInput>;
};

type BatchInputs = {
  endpoint?: string;
  inputs: Map<string, BatchInputRecord>;
  issues: Error[];
};

type BatchTraceContext = {
  inputFileId: string;
  endpoint: string;
  parent: string;
  taskStartTime: number;
  childStartTime: number;
};

type PendingBatchTrace = {
  context: BatchTraceContext;
  inputs: Map<string, BatchInputRecord>;
  endTime?: number;
  status?: string;
};

type BatchResultRecord = {
  value: Record<string, unknown>;
  source: "output" | "error";
};

const pendingBatchTraces = new Map<string, PendingBatchTrace>();

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
  return (
    typeof read(value, Symbol.iterator) === "function" ||
    typeof read(value, Symbol.asyncIterator) === "function"
  );
}

function validCustomId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function logBatchInstrumentationError(context: string, error: unknown): void {
  debugLogger.debug(`OpenAI Batch instrumentation ${context}:`, error);
}

async function exportParent(
  parent: { export(): Promise<string> } | { toStr(): string },
): Promise<string | undefined> {
  if ("toStr" in parent && typeof parent.toStr === "function") {
    return parent.toStr();
  }
  if ("export" in parent && typeof parent.export === "function") {
    return await parent.export();
  }
  return undefined;
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

async function batchSpanIds(inputFileId: string): Promise<{
  rowId: string;
  spanId: string;
  rootSpanId: string;
}> {
  const [row, span, root] = await Promise.all([
    deterministicDigest("openai:batch:row", inputFileId),
    deterministicDigest("openai:batch:span", inputFileId),
    deterministicDigest("openai:batch:root", inputFileId),
  ]);
  return {
    rowId: digestUuid(row),
    spanId: digestHex(span, 8),
    rootSpanId: digestHex(root, 16),
  };
}

async function childSpanIds(inputFileId: string, customId: string) {
  const [row, span] = await Promise.all([
    deterministicDigest("openai:batch:child:row", inputFileId, customId),
    deterministicDigest("openai:batch:child:span", inputFileId, customId),
  ]);
  return { rowId: digestUuid(row), spanId: digestHex(span, 8) };
}

async function startBatchSpan(context: BatchTraceContext): Promise<Span> {
  const ids = await batchSpanIds(context.inputFileId);
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
          startTime: context.taskStartTime,
          event: {
            id: ids.rowId,
            metadata: {
              endpoint: context.endpoint,
              input_file_id: context.inputFileId,
              provider: "openai",
            },
          },
        },
        INSTRUMENTATION_NAMES.OPENAI,
      ),
    ),
  );
}

async function startBatchChild(
  context: BatchTraceContext,
  taskParent: string,
  input: BatchInputRecord,
): Promise<Span> {
  const ids = await childSpanIds(context.inputFileId, input.customId);
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
          startTime: context.childStartTime,
          event: {
            id: ids.rowId,
            ...(input.spanData?.input !== undefined
              ? { input: input.spanData.input }
              : {}),
            metadata: {
              ...input.spanData?.metadata,
              custom_id: input.customId,
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
  file: OpenAIBatchFile,
  onIssue: (error: Error) => void = () => {},
): AsyncGenerator<unknown> {
  const resolvedFile = await file;
  if (typeof resolvedFile === "string") {
    for (const line of resolvedFile.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        yield JSON.parse(line.replace(/\r$/, ""));
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
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const readChunk = read(reader, "read");
        if (typeof readChunk !== "function") {
          throw new Error("Response body stream has no read method");
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
              onIssue(new Error("OpenAI Batch file contains malformed JSONL"));
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
          onIssue(new Error("OpenAI Batch file contains malformed JSONL"));
        }
      }
    } catch (error) {
      logBatchInstrumentationError("could not read JSONL response body", error);
      onIssue(new Error("OpenAI Batch response body could not be read"));
    } finally {
      const releaseLock = read(reader, "releaseLock");
      if (typeof releaseLock === "function") {
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
    return;
  }

  logBatchInstrumentationError("skipped invalid JSONL source", resolvedFile);
  onIssue(new Error("OpenAI Batch file source is invalid"));
}

async function readBatchInputs(file: OpenAIBatchFile): Promise<BatchInputs> {
  const inputs = new Map<string, BatchInputRecord>();
  const issues: Error[] = [];
  let endpoint: string | undefined;
  try {
    for await (const value of jsonlRecords(file, (issue) =>
      issues.push(issue),
    )) {
      const customId = read(value, "custom_id");
      const url = read(value, "url");
      const body = read(value, "body");
      if (
        !validCustomId(customId) ||
        inputs.has(customId) ||
        read(value, "method") !== "POST" ||
        typeof url !== "string" ||
        !SUPPORTED_ENDPOINTS.has(url) ||
        (endpoint !== undefined && endpoint !== url) ||
        !isObject(body)
      ) {
        issues.push(new Error("OpenAI Batch input contains an invalid record"));
        continue;
      }
      endpoint = url;
      let spanData: BatchInputRecord["spanData"];
      try {
        spanData = extractOpenAIBatchInput(url, body);
      } catch (error) {
        logBatchInstrumentationError("could not extract batch input", error);
      }
      inputs.set(customId, { customId, spanData });
    }
  } catch (error) {
    logBatchInstrumentationError("could not process input file", error);
    issues.push(new Error("OpenAI Batch input file could not be processed"));
  }
  if (!endpoint || inputs.size === 0) {
    issues.push(new Error("OpenAI Batch input contains no supported records"));
  }
  return { endpoint, inputs, issues };
}

async function writePendingSpans(
  trace: PendingBatchTrace,
  endTime?: number,
): Promise<void> {
  const task = await startBatchSpan(trace.context);
  const taskParent = await task.export();
  for (const input of trace.inputs.values()) {
    try {
      const child = await startBatchChild(trace.context, taskParent, input);
      if (endTime !== undefined) {
        child.end({ endTime });
      }
    } catch (error) {
      logBatchInstrumentationError("could not write batch request span", error);
    }
  }
  if (endTime !== undefined) {
    if (trace.status && trace.status !== "completed") {
      task.log({ error: new Error(`OpenAI Batch ${trace.status}`) });
    }
    task.end({ endTime });
  }
}

export const interceptOpenAIFilesCreateTraced: Parameters<
  typeof openAIChannels.filesCreateTraced.intercept
>[0] = async (target, thisArg, args) => {
  const startTime = getCurrentUnixTimestamp();
  const inputPromise = readBatchInputs(args[0].inputFileContent);
  const parentPromise = exportParent(args[0].parent);
  const file = await Reflect.apply(target, thisArg, args);
  try {
    const inputFileId = read(file, "id");
    const [inputData, exportedParent] = await Promise.all([
      inputPromise,
      parentPromise,
    ]);
    if (
      typeof inputFileId !== "string" ||
      !exportedParent ||
      !inputData.endpoint ||
      inputData.issues.length > 0
    ) {
      if (inputData.issues[0]) {
        logBatchInstrumentationError(
          "skipped invalid input file",
          inputData.issues[0],
        );
      }
      return file;
    }
    const trace: PendingBatchTrace = {
      context: {
        inputFileId,
        endpoint: inputData.endpoint,
        parent: exportedParent,
        taskStartTime: startTime,
        childStartTime: startTime,
      },
      inputs: inputData.inputs,
    };
    pendingBatchTraces.set(inputFileId, trace);
    await writePendingSpans(trace);
  } catch (error) {
    logBatchInstrumentationError("could not start batch spans", error);
  }
  return file;
};

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function terminalEndTime(batch: OpenAIBatchLike, startTime: number): number {
  let timestamp: unknown;
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
  return validTimestamp(timestamp)
    ? Math.max(timestamp, startTime)
    : Math.max(getCurrentUnixTimestamp(), startTime);
}

async function updateBatchTimestamps(batch: OpenAIBatchLike): Promise<void> {
  const trace = pendingBatchTraces.get(batch.input_file_id);
  if (!trace || trace.context.endpoint !== batch.endpoint) {
    return;
  }
  if (validTimestamp(batch.created_at)) {
    trace.context.taskStartTime = batch.created_at;
  }
  trace.context.childStartTime = validTimestamp(batch.in_progress_at)
    ? Math.max(batch.in_progress_at, trace.context.taskStartTime)
    : trace.context.taskStartTime;
  trace.status = batch.status;
  if (TERMINAL_STATUSES.has(batch.status)) {
    trace.endTime = terminalEndTime(batch, trace.context.childStartTime);
  }
  await writePendingSpans(trace, trace.endTime);
}

export const interceptOpenAIBatchesRetrieveTraced: Parameters<
  typeof openAIChannels.batchesRetrieveTraced.intercept
>[0] = (target, thisArg, args) =>
  Promise.resolve(Reflect.apply(target, thisArg, args)).then(async (batch) => {
    try {
      await updateBatchTimestamps(batch);
    } catch (error) {
      logBatchInstrumentationError("could not update batch timestamps", error);
    }
    return batch;
  });

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
    const message = read(read(read(response, "body"), "error"), "message");
    return new Error(
      typeof message === "string" ? message : "OpenAI Batch request failed",
    );
  }
  return undefined;
}

async function completeBatchResult(
  context: BatchTraceContext,
  taskParent: string,
  endTime: number,
  input: BatchInputRecord,
  result: BatchResultRecord,
): Promise<void> {
  const child = await startBatchChild(context, taskParent, input);
  try {
    const resultError = errorFromResult(result);
    const responseBody = read(read(result.value, "response"), "body");
    if (resultError) {
      child.log({ error: resultError });
    } else if (isObject(responseBody)) {
      const model = read(responseBody, "model");
      child.log({
        output:
          context.endpoint === "/v1/chat/completions"
            ? read(responseBody, "choices")
            : processImagesInOutput(read(responseBody, "output")),
        ...(typeof model === "string" ? { metadata: { model } } : {}),
        metrics: parseMetricsFromUsage(read(responseBody, "usage")),
      });
    } else {
      child.log({ error: new Error("OpenAI Batch response body is missing") });
    }
  } catch (error) {
    child.log({ error });
  } finally {
    child.end({ endTime });
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
  context: BatchTraceContext;
  endTime: number;
  file: OpenAIBatchFile | undefined;
  inputs: Map<string, BatchInputRecord>;
  issues: Error[];
  seen: Set<string>;
  source: BatchResultRecord["source"];
  taskParent: string;
}): Promise<void> {
  if (file === undefined) {
    return;
  }
  for await (const value of jsonlRecords(file, (issue) => issues.push(issue))) {
    const customId = read(value, "custom_id");
    if (!validCustomId(customId) || !isObject(value)) {
      issues.push(
        new Error("OpenAI Batch result is missing a valid custom_id"),
      );
      continue;
    }
    if (seen.has(customId)) {
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
  }
}

function sameInputs(
  first: Map<string, BatchInputRecord>,
  second: Map<string, BatchInputRecord>,
): boolean {
  return (
    first.size === second.size &&
    [...first.keys()].every((customId) => second.has(customId))
  );
}

async function contextForCompletion(
  inputFileId: string,
  inputData: BatchInputs,
): Promise<PendingBatchTrace | undefined> {
  if (!inputData.endpoint || inputData.issues.length > 0) {
    return undefined;
  }
  const existing = pendingBatchTraces.get(inputFileId);
  if (existing) {
    if (
      existing.context.endpoint !== inputData.endpoint ||
      !sameInputs(existing.inputs, inputData.inputs)
    ) {
      return undefined;
    }
    return { ...existing, inputs: inputData.inputs };
  }
  const parent = await exportParent(getSpanParentObject());
  if (!parent) {
    return undefined;
  }
  const startTime = getCurrentUnixTimestamp();
  return {
    context: {
      inputFileId,
      endpoint: inputData.endpoint,
      parent,
      taskStartTime: startTime,
      childStartTime: startTime,
    },
    inputs: inputData.inputs,
  };
}

async function completeBatch(
  args: CompleteOpenAIBatchTraceArgs,
): Promise<void> {
  const inputData = await readBatchInputs(args.inputFileContent);
  const trace = await contextForCompletion(args.inputFileId, inputData);
  if (!trace) {
    logBatchInstrumentationError(
      "left batch spans pending",
      inputData.issues[0] ?? new Error("OpenAI Batch input does not match"),
    );
    return;
  }
  const endTime = trace.endTime ?? getCurrentUnixTimestamp();
  const task = await startBatchSpan(trace.context);
  const taskParent = await task.export();
  const issues: Error[] = [];
  const seen = new Set<string>();
  await Promise.all([
    completeResultFile({
      context: trace.context,
      endTime,
      file: args.outputFileContent,
      inputs: trace.inputs,
      issues,
      seen,
      source: "output",
      taskParent,
    }),
    completeResultFile({
      context: trace.context,
      endTime,
      file: args.errorFileContent,
      inputs: trace.inputs,
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

  const missing = [...trace.inputs.values()].filter(
    ({ customId }) => !seen.has(customId),
  );
  if (!trace.status || trace.status === "completed") {
    if (missing.length > 0) {
      logBatchInstrumentationError(
        "left batch spans pending",
        new Error("OpenAI Batch result files are incomplete"),
      );
      return;
    }
  } else {
    for (const input of missing) {
      const child = await startBatchChild(trace.context, taskParent, input);
      child.log({ error: new Error(`OpenAI Batch ${trace.status}`) });
      child.end({ endTime });
    }
    task.log({ error: new Error(`OpenAI Batch ${trace.status}`) });
  }
  task.end({ endTime });
  pendingBatchTraces.delete(args.inputFileId);
}

export const interceptOpenAIBatchTraceComplete: Parameters<
  typeof openAIChannels.batchesCompleteTrace.intercept
>[0] = (target, thisArg, args) =>
  Promise.resolve(Reflect.apply(target, thisArg, args)).then(async (result) => {
    try {
      await completeBatch(args[0]);
    } catch (error) {
      logBatchInstrumentationError("could not complete batch", error);
    }
    return result;
  });
