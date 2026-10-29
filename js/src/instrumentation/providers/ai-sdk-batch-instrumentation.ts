import { isObject, SpanTypeAttribute } from "../../../util";
import { SpanComponentsV4 } from "../../../util/span_identifier_v4";
import { debugLogger } from "../../debug-logger";
import {
  _internalStartSpanWithInitialMerge,
  _internalStartSpanWithInitialMergeAndParentSpanIds,
  getSpanParentObject,
  NOOP_SPAN,
  withCurrent,
  type Span,
} from "../../logger/core";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { getCurrentUnixTimestamp } from "../../util";
import type {
  AISDKBatchReference,
  AISDKBatchStatus,
  AISDKBatchRequest,
  StartAISDKBatchTraceArgs,
  CompleteAISDKBatchTraceArgs,
} from "../../vendor-sdk-types/ai-sdk-batch";
import { runInstrumentation } from "../core/observe-result";
import { extractTokenMetrics } from "./ai-sdk-metrics";
import { aiSDKBatchInput, aiSDKBatchOutput } from "./ai-sdk-batch-span-data";
import {
  deterministicDigest,
  digestHex,
  digestUuid,
} from "./openai-manual-instrumentation-utils";

type BatchContext = {
  version: 1;
  batch: AISDKBatchReference;
  parent: string;
  startTime: number;
  inputDigest: string;
};
type BatchRequestIdentity = { rowId: string; spanId: string; model: string };
type BatchTrace = {
  context: BatchContext;
  status: AISDKBatchStatus["status"];
  rowId: string;
  spanId: string;
  rootSpanId: string;
  taskParent: string;
  children: Map<string, BatchRequestIdentity>;
};

function batchSpan(trace: BatchTrace): Span {
  const parent = SpanComponentsV4.fromStr(trace.context.parent);
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMergeAndParentSpanIds(
      withSpanInstrumentationName(
        {
          name: "ai.batch",
          type: SpanTypeAttribute.TASK,
          parent: trace.context.parent,
          ...(!parent.data.span_id
            ? {
                parentSpanIds: {
                  parentSpanIds: [],
                  rootSpanId: trace.rootSpanId,
                },
              }
            : {}),
          spanId: trace.spanId,
          startTime: trace.context.startTime,
          event: {
            id: trace.rowId,
            metadata: {
              batch_id: trace.context.batch.id,
              provider: trace.context.batch.provider,
              status: trace.status,
            },
          },
        },
        INSTRUMENTATION_NAMES.AI_SDK,
      ),
    ),
  );
}

function requestSpan(
  trace: BatchTrace,
  id: string,
  identity: BatchRequestIdentity,
): Span {
  return withCurrent(NOOP_SPAN, () =>
    _internalStartSpanWithInitialMerge(
      withSpanInstrumentationName(
        {
          name: "ai.batch.request",
          type: SpanTypeAttribute.LLM,
          parent: trace.taskParent,
          spanId: identity.spanId,
          startTime: trace.context.startTime,
          event: {
            id: identity.rowId,
            metadata: {
              batch_id: trace.context.batch.id,
              request_id: id,
              model: identity.model,
              provider: trace.context.batch.provider,
            },
          },
        },
        INSTRUMENTATION_NAMES.AI_SDK,
      ),
    ),
  );
}

/** Context is constant-size; the caller supplies the original input identities. */
async function batchContext(
  { batch, requests, startTime }: StartAISDKBatchTraceArgs,
  serialized?: string,
): Promise<BatchContext | undefined> {
  if (
    batch.version !== 2 ||
    typeof batch.id !== "string" ||
    !batch.id ||
    typeof batch.provider !== "string" ||
    !batch.provider ||
    !Array.isArray(requests) ||
    requests.length === 0 ||
    requests.some(
      (request) =>
        request.type !== "text" ||
        typeof request.id !== "string" ||
        !request.id ||
        typeof request.model !== "string" ||
        !request.model,
    ) ||
    new Set(requests.map((request) => request.id)).size !== requests.length
  ) {
    debugLogger.debug("Unsupported AI SDK batch inputs");
    return;
  }
  const inputDigest = digestHex(
    await deterministicDigest(
      "ai:batch:inputs",
      ...requests.map(({ id, model }) => JSON.stringify([id, model])).sort(),
    ),
    32,
  );
  if (serialized !== undefined) {
    try {
      const value: unknown = JSON.parse(serialized);
      if (
        !isObject(value) ||
        value.version !== 1 ||
        !isObject(value.batch) ||
        value.batch.version !== batch.version ||
        value.batch.id !== batch.id ||
        value.batch.provider !== batch.provider ||
        value.inputDigest !== inputDigest ||
        typeof value.parent !== "string" ||
        typeof value.startTime !== "number" ||
        !Number.isFinite(value.startTime) ||
        value.startTime < 0
      ) {
        throw new Error("Invalid batch context");
      }
      const parent = SpanComponentsV4.fromStr(value.parent);
      return {
        version: 1,
        batch: { version: 2, id: batch.id, provider: batch.provider },
        parent: new SpanComponentsV4({
          ...parent.data,
          propagated_event: undefined,
        }).toStr(),
        startTime: value.startTime,
        inputDigest,
      };
    } catch {
      // Never include untrusted serialized context in diagnostics.
      debugLogger.debug(
        "Invalid AI SDK batch trace context or mismatched inputs",
      );
      return;
    }
  }
  const parent = getSpanParentObject();
  const routing = SpanComponentsV4.fromStr(
    "toStr" in parent ? parent.toStr() : await parent.export(),
  );
  const createdAt = batch.createdAt ? Date.parse(batch.createdAt) / 1000 : NaN;
  return {
    version: 1,
    batch: { version: 2, id: batch.id, provider: batch.provider },
    parent: new SpanComponentsV4({
      ...routing.data,
      propagated_event: undefined,
    }).toStr(),
    startTime:
      startTime !== undefined && Number.isFinite(startTime) && startTime >= 0
        ? startTime
        : Number.isFinite(createdAt) && createdAt >= 0
          ? createdAt
          : getCurrentUnixTimestamp(),
    inputDigest,
  };
}

async function createTrace(
  context: BatchContext,
  requests: ReadonlyArray<AISDKBatchRequest>,
  status: AISDKBatchStatus["status"],
): Promise<BatchTrace> {
  const key = JSON.stringify([context.batch.provider, context.batch.id]);
  const [row, span, root] = await Promise.all([
    deterministicDigest("ai:batch:row", key),
    deterministicDigest("ai:batch:span", key),
    deterministicDigest("ai:batch:root", key),
  ]);
  const trace: BatchTrace = {
    context,
    status,
    rowId: digestUuid(row),
    spanId: digestHex(span, 8),
    rootSpanId: digestHex(root, 16),
    taskParent: "",
    children: new Map(),
  };
  // Keep only identities, with bounded hashing and span construction.
  for (const { id, model } of requests) {
    const digest = await deterministicDigest("ai:batch:request", key, id);
    trace.children.set(id, {
      rowId: digestUuid(digest),
      spanId: digestHex(digest, 8),
      model,
    });
  }
  trace.taskParent = await batchSpan(trace).export();
  return trace;
}

export async function captureAISDKBatchStart(
  args: StartAISDKBatchTraceArgs,
): Promise<string | undefined> {
  return runInstrumentation(async () => {
    const context = await batchContext(args);
    if (!context) return;
    const trace = await createTrace(
      context,
      args.requests,
      args.batch.status ?? "pending",
    );
    for (const request of args.requests) {
      const data = await aiSDKBatchInput(request);
      requestSpan(trace, request.id, trace.children.get(request.id)!).log(data);
    }
    return JSON.stringify(context);
  })?.catch(() => undefined);
}

export async function captureAISDKBatchCompletion(
  args: CompleteAISDKBatchTraceArgs,
  denyOutputPaths: string[],
): Promise<void> {
  await runInstrumentation(async () => {
    // A live AI SDK results stream performs provider requests when iterated.
    // Accept only records the caller has already collected, never lazy sources.
    if (
      !Array.isArray(args.results) ||
      !["pending", "completed", "failed"].includes(args.status.status)
    ) {
      debugLogger.debug(
        "AI SDK batch capture requires collected records and a valid status",
      );
      return;
    }
    const context = await batchContext(
      {
        batch: { ...args.batch, createdAt: args.status.createdAt },
        requests: args.requests,
      },
      args.context,
    );
    if (!context) return;
    const trace = await createTrace(context, args.requests, args.status.status);
    if (args.context === undefined) {
      for (const request of args.requests) {
        const data = await aiSDKBatchInput(request);
        requestSpan(trace, request.id, trace.children.get(request.id)!).log(
          data,
        );
      }
    }
    const task = batchSpan(trace);
    task.log({
      metadata: {
        raw_status: args.status.rawStatus,
        ...(args.status.requestCounts
          ? {
              request_counts: {
                total: args.status.requestCounts.total,
                pending: args.status.requestCounts.pending,
                completed: args.status.requestCounts.completed,
                failed: args.status.requestCounts.failed,
              },
            }
          : {}),
      },
    });
    const endTime = Math.max(
      context.startTime,
      args.endTime !== undefined && Number.isFinite(args.endTime)
        ? args.endTime
        : getCurrentUnixTimestamp(),
    );
    const seen = new Set<string>();
    let invalid = false;
    for (const item of args.results) {
      const identity = trace.children.get(item.id);
      if (
        !identity ||
        item.type !== "text" ||
        seen.has(item.id) ||
        !["succeeded", "failed", "cancelled", "expired"].includes(item.status)
      ) {
        invalid = true;
        debugLogger.debug(
          "AI SDK batch result has an invalid, unknown or duplicate request ID/status",
        );
        continue;
      }
      seen.add(item.id);
      const child = requestSpan(trace, item.id, identity);
      if (item.status === "succeeded") {
        child.log({
          output: aiSDKBatchOutput(
            item,
            args.denyOutputPaths ?? denyOutputPaths,
          ),
          metrics: extractTokenMetrics({
            usage: item.usage,
            providerMetadata: item.providerMetadata,
          }),
          metadata: {
            status: item.status,
            ...(typeof item.response?.modelId === "string"
              ? { model: item.response.modelId }
              : {}),
          },
        });
      } else {
        child.log({
          error: new Error(
            item.error?.message ?? `AI SDK batch request ${item.status}`,
          ),
          metadata: { status: item.status },
        });
      }
      if (args.status.status !== "pending") child.end({ endTime });
    }
    if (invalid || args.status.status === "pending") return;
    if (args.status.status === "failed") {
      const error = new Error(
        args.status.error?.message ??
          `AI SDK batch ${args.status.rawStatus ?? "failed"}`,
      );
      task.log({ error });
      for (const [id, identity] of trace.children) {
        if (seen.has(id)) continue;
        const child = requestSpan(trace, id, identity);
        child.log({ error });
        child.end({ endTime });
      }
    } else if (seen.size !== trace.children.size) {
      debugLogger.debug(
        "AI SDK batch results are incomplete; leaving the trace pending",
      );
      return;
    }
    task.end({ endTime });
  })?.catch(() => {});
}
