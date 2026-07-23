import { SpanTypeAttribute } from "../../../util/index";
import { debugLogger } from "../../debug-logger";
import { startSpan as startBaseSpan } from "../../logger";
import type { Span } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import { LRUCache } from "../../lru-cache";
import type {
  LangSmithBatchIngestRuns,
  LangSmithRun,
} from "../../vendor-sdk-types/langsmith";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import type { ChannelMessage } from "../core/channel-definitions";
import { langSmithChannels } from "./langsmith-channels";

type ActiveRun = {
  run: LangSmithRun;
  span: Span;
};

type LangSmithPluginOptions = {
  skipLangChainRuns?: boolean;
};

const MAX_COMPLETED_RUNS = 10_000;
const BLOCKED_METADATA_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "usage_metadata",
]);
const BLOCKED_METADATA_PREFIXES = ["__pregel_", "langgraph_", "lc_"];
const LLM_SETTING_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "response_format",
] as const;

export class LangSmithPlugin extends BasePlugin {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly completedRuns = new LRUCache<string, true>({
    max: MAX_COMPLETED_RUNS,
  });
  private readonly skipLangChainRuns: boolean;

  constructor(options: LangSmithPluginOptions = {}) {
    super();
    this.skipLangChainRuns = options.skipLangChainRuns ?? true;
  }

  protected onEnable(): void {
    const createChannel = langSmithChannels.createRun.tracingChannel();
    const createHandlers = {
      start: (
        event: ChannelMessage<typeof langSmithChannels.createRun>,
      ): void => {
        this.containLifecycleFailure("createRun", () => {
          this.processCreate(event.arguments[0]);
        });
      },
    };
    createChannel.subscribe(createHandlers);
    this.unsubscribers.push(() => createChannel.unsubscribe(createHandlers));

    const updateChannel = langSmithChannels.updateRun.tracingChannel();
    const updateHandlers = {
      start: (
        event: ChannelMessage<typeof langSmithChannels.updateRun>,
      ): void => {
        this.containLifecycleFailure("updateRun", () => {
          this.processUpdate(event.arguments[0], event.arguments[1]);
        });
      },
    };
    updateChannel.subscribe(updateHandlers);
    this.unsubscribers.push(() => updateChannel.unsubscribe(updateHandlers));

    const batchChannel = langSmithChannels.batchIngestRuns.tracingChannel();
    const batchHandlers = {
      start: (
        event: ChannelMessage<typeof langSmithChannels.batchIngestRuns>,
      ): void => {
        this.containLifecycleFailure("batchIngestRuns", () => {
          this.processBatch(event.arguments[0]);
        });
      },
    };
    batchChannel.subscribe(batchHandlers);
    this.unsubscribers.push(() => batchChannel.unsubscribe(batchHandlers));
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
    for (const { span } of this.activeRuns.values()) {
      span.end();
    }
    this.activeRuns.clear();
    this.completedRuns.clear();
  }

  private processBatch(batch: LangSmithBatchIngestRuns): void {
    if (!isRecord(batch)) {
      return;
    }

    const creates = ownValue(batch, "runCreates");
    if (Array.isArray(creates)) {
      const parentFirst = [...creates].sort((left, right) => {
        const leftId = stringValue(ownValue(left, "id"));
        const rightId = stringValue(ownValue(right, "id"));
        const leftParent = stringValue(ownValue(left, "parent_run_id"));
        const rightParent = stringValue(ownValue(right, "parent_run_id"));
        if (leftParent && leftParent === rightId) {
          return 1;
        }
        if (rightParent && rightParent === leftId) {
          return -1;
        }
        return dottedOrderDepth(left) - dottedOrderDepth(right);
      });
      for (const run of parentFirst) {
        this.containLifecycleFailure("batchIngestRuns create", () => {
          this.processCreate(run);
        });
      }
    }

    const updates = ownValue(batch, "runUpdates");
    if (Array.isArray(updates)) {
      for (const run of updates) {
        this.containLifecycleFailure("batchIngestRuns update", () => {
          this.processUpdate(stringValue(ownValue(run, "id")) ?? "", run);
        });
      }
    }
  }

  private processCreate(run: LangSmithRun): void {
    const id = stringValue(ownValue(run, "id"));
    if (!id || this.completedRuns.get(id)) {
      return;
    }
    if (this.shouldSkipLangChainRun(run)) {
      this.completedRuns.set(id, true);
      return;
    }

    const active = this.activeRuns.get(id);
    if (active) {
      const previous = active.run;
      active.run = mergeRuns(previous, run);
      this.logRun(
        active.span,
        active.run,
        previous,
        timestampSeconds(ownValue(active.run, "end_time")) !== undefined ||
          errorMessage(ownValue(active.run, "error")) !== undefined,
      );
      this.endIfComplete(id, active, active.run);
      return;
    }

    const span = this.startRunSpan(id, run);
    const activeRun = { run, span };
    this.activeRuns.set(id, activeRun);
    this.logRun(
      span,
      run,
      undefined,
      timestampSeconds(ownValue(run, "end_time")) !== undefined ||
        errorMessage(ownValue(run, "error")) !== undefined,
    );
    this.endIfComplete(id, activeRun, run);
  }

  private processUpdate(explicitId: string, run: LangSmithRun): void {
    const id = stringValue(explicitId) ?? stringValue(ownValue(run, "id"));
    if (!id || this.completedRuns.get(id)) {
      return;
    }
    if (this.shouldSkipLangChainRun(run)) {
      const active = this.activeRuns.get(id);
      active?.span.end();
      this.activeRuns.delete(id);
      this.completedRuns.set(id, true);
      return;
    }

    let active = this.activeRuns.get(id);
    if (!active) {
      const span = this.startRunSpan(id, run);
      active = { run, span };
      this.activeRuns.set(id, active);
    }

    const previous = active.run;
    active.run = mergeRuns(previous, run);
    this.logRun(active.span, active.run, previous, true);
    this.endIfComplete(id, active, active.run);
  }

  private startRunSpan(id: string, run: LangSmithRun): Span {
    const traceId = stringValue(ownValue(run, "trace_id")) ?? id;
    const parentId =
      stringValue(ownValue(run, "parent_run_id")) ??
      stringValue(ownValue(ownValue(run, "parent_run"), "id"));
    const startTime = timestampSeconds(ownValue(run, "start_time"));

    return startBaseSpan(
      withSpanInstrumentationName(
        {
          name: stringValue(ownValue(run, "name")) ?? "LangSmith run",
          spanId: id,
          parentSpanIds: {
            parentSpanIds: parentId ? [parentId] : [],
            rootSpanId: traceId,
          },
          spanAttributes: {
            type: mapRunType(ownValue(run, "run_type")),
          },
          ...(startTime === undefined ? {} : { startTime }),
          event: { id },
        },
        INSTRUMENTATION_NAMES.LANGSMITH,
      ),
    );
  }

  private logRun(
    span: Span,
    run: LangSmithRun,
    previous: LangSmithRun | undefined,
    includeOutput: boolean,
  ): void {
    const inputs = preferOwnValue(run, previous, "inputs");
    const outputs = preferOwnValue(run, previous, "outputs");
    const error = errorMessage(preferOwnValue(run, previous, "error"));
    const metadata = extractMetadata(run, previous);
    const tags = extractTags(preferOwnValue(run, previous, "tags"));
    const metrics = extractMetrics(run, previous);

    span.log({
      ...(inputs === undefined ? {} : { input: sanitizeLoggedValue(inputs) }),
      ...(includeOutput && outputs !== undefined
        ? { output: sanitizeLoggedValue(outputs) }
        : {}),
      ...(error === undefined ? {} : { error }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(tags === undefined ? {} : { tags }),
      ...(Object.keys(metrics).length === 0 ? {} : { metrics }),
    });
  }

  private endIfComplete(
    id: string,
    active: ActiveRun,
    run: LangSmithRun,
  ): void {
    const endTime = timestampSeconds(ownValue(run, "end_time"));
    if (
      endTime === undefined &&
      errorMessage(ownValue(run, "error")) === undefined
    ) {
      return;
    }
    active.span.end(endTime === undefined ? undefined : { endTime });
    this.activeRuns.delete(id);
    this.completedRuns.set(id, true);
  }

  private shouldSkipLangChainRun(run: LangSmithRun): boolean {
    if (!this.skipLangChainRuns) {
      return false;
    }
    const serialized = ownValue(run, "serialized");
    return isRecord(serialized) && ownValue(serialized, "lc") === 1;
  }

  private containLifecycleFailure(operation: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      debugLogger.error(
        `Failed to process LangSmith ${operation} instrumentation:`,
        error,
      );
    }
  }
}

function ownValue(value: unknown, key: PropertyKey): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function preferOwnValue(
  current: unknown,
  previous: unknown,
  key: PropertyKey,
): unknown {
  const currentDescriptor = isRecord(current)
    ? Object.getOwnPropertyDescriptor(current, key)
    : undefined;
  if (currentDescriptor && "value" in currentDescriptor) {
    return currentDescriptor.value;
  }
  return ownValue(previous, key);
}

function mergeRuns(
  previous: LangSmithRun,
  current: LangSmithRun,
): LangSmithRun {
  const entries = new Map<string, unknown>();
  for (const value of [previous, current]) {
    if (!isRecord(value)) {
      continue;
    }
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (descriptor.enumerable && "value" in descriptor) {
        entries.set(key, descriptor.value);
      }
    }
  }
  return Object.fromEntries(entries);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampSeconds(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp / 1000 : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value > 10_000_000_000 ? value / 1000 : value;
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp / 1000 : undefined;
  }
  return undefined;
}

function dottedOrderDepth(run: unknown): number {
  const dottedOrder = stringValue(ownValue(run, "dotted_order"));
  return dottedOrder ? dottedOrder.split(".").length : Number.MAX_SAFE_INTEGER;
}

function mapRunType(runType: unknown): SpanTypeAttribute {
  switch (runType) {
    case "llm":
    case "embedding":
      return SpanTypeAttribute.LLM;
    case "tool":
    case "retriever":
      return SpanTypeAttribute.TOOL;
    default:
      return SpanTypeAttribute.TASK;
  }
}

function extractMetadata(
  run: LangSmithRun,
  previous: LangSmithRun | undefined,
): Record<string, unknown> | undefined {
  const extra = preferOwnValue(run, previous, "extra");
  const rawMetadata = ownValue(extra, "metadata");
  if (!isRecord(rawMetadata)) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(rawMetadata),
  )) {
    if (
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      BLOCKED_METADATA_KEYS.has(key) ||
      BLOCKED_METADATA_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      (key.startsWith("ls_") &&
        key !== "ls_provider" &&
        key !== "ls_model_name" &&
        !LLM_SETTING_KEYS.some((setting) => key === `ls_${setting}`))
    ) {
      continue;
    }

    const normalizedKey =
      key === "ls_provider"
        ? "provider"
        : key === "ls_model_name"
          ? "model"
          : key.startsWith("ls_")
            ? key.slice(3)
            : key;
    const sanitized = sanitizeLoggedValue(descriptor.value);
    if (sanitized !== undefined) {
      metadata[normalizedKey] = sanitized;
    }
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function extractTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = value.filter(
    (tag): tag is string => typeof tag === "string" && tag.length > 0,
  );
  return tags.length > 0 ? tags : undefined;
}

function extractMetrics(
  run: LangSmithRun,
  previous: LangSmithRun | undefined,
): Record<string, number> {
  const outputs = preferOwnValue(run, previous, "outputs");
  const extra = preferOwnValue(run, previous, "extra");
  const metadata = ownValue(extra, "metadata");
  const usage =
    ownValue(outputs, "usage_metadata") ?? ownValue(metadata, "usage_metadata");
  const metrics: Record<string, number> = {};

  assignFirstMetric(metrics, "prompt_tokens", usage, [
    "input_tokens",
    "prompt_tokens",
  ]);
  assignFirstMetric(metrics, "completion_tokens", usage, [
    "output_tokens",
    "completion_tokens",
  ]);
  assignFirstMetric(metrics, "tokens", usage, ["total_tokens", "tokens"]);

  const inputTokenDetails = ownValue(usage, "input_token_details");
  assignFirstMetric(metrics, "prompt_cached_tokens", inputTokenDetails, [
    "cache_read",
    "cached_tokens",
  ]);
  if (metrics.prompt_cached_tokens === undefined) {
    assignFirstMetric(metrics, "prompt_cached_tokens", usage, [
      "cache_read_input_tokens",
      "prompt_cached_tokens",
    ]);
  }
  assignFirstMetric(
    metrics,
    "prompt_cache_creation_tokens",
    inputTokenDetails,
    ["cache_creation"],
  );
  if (metrics.prompt_cache_creation_tokens === undefined) {
    assignFirstMetric(metrics, "prompt_cache_creation_tokens", usage, [
      "cache_creation_input_tokens",
      "prompt_cache_creation_tokens",
    ]);
  }

  if (
    metrics.tokens === undefined &&
    (metrics.prompt_tokens !== undefined ||
      metrics.completion_tokens !== undefined)
  ) {
    metrics.tokens =
      (metrics.prompt_tokens ?? 0) + (metrics.completion_tokens ?? 0);
  }

  const startTime = timestampSeconds(
    preferOwnValue(run, previous, "start_time"),
  );
  const events = preferOwnValue(run, previous, "events");
  if (startTime !== undefined && Array.isArray(events)) {
    for (const event of events) {
      if (ownValue(event, "name") !== "new_token") {
        continue;
      }
      const eventTime = timestampSeconds(ownValue(event, "time"));
      if (eventTime !== undefined && eventTime >= startTime) {
        metrics.time_to_first_token = eventTime - startTime;
      }
      break;
    }
  }

  return metrics;
}

function assignFirstMetric(
  metrics: Record<string, number>,
  target: string,
  source: unknown,
  keys: string[],
): void {
  for (const key of keys) {
    const value = ownValue(source, key);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      metrics[target] = value;
      return;
    }
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  return undefined;
}

function sanitizeLoggedValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (typeof value !== "object" || depth >= 20) {
    return undefined;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLoggedValue(item, seen, depth + 1));
  }

  const entries: Array<[string, unknown]> = [];
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      BLOCKED_METADATA_KEYS.has(key)
    ) {
      continue;
    }
    entries.push([key, sanitizeLoggedValue(descriptor.value, seen, depth + 1)]);
  }
  return Object.fromEntries(entries);
}
