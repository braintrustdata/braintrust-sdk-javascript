/**
 * Braintrust integration for `@mastra/core`'s observability pipeline.
 *
 * Mastra ships a public `ObservabilityExporter` extension contract documented
 * at https://mastra.ai/docs/observability/tracing/exporters/braintrust . This
 * file implements that contract: every Mastra `TracingEvent` (one of
 * SPAN_STARTED / SPAN_UPDATED / SPAN_ENDED) is translated into a Braintrust
 * span, parented via the Mastra-supplied `parentSpanId`.
 *
 * Two integration paths:
 *   - **Manual**: `new Mastra({ observability: new Observability({ configs: {
 *     default: { exporters: [new BraintrustObservabilityExporter()] } } }) })`
 *   - **Auto** (under `node --import braintrust/hook.mjs`): the loader patches
 *     `@mastra/core`'s `dist/mastra/index.{js,cjs}` to wrap `Mastra` so it
 *     calls `defaultInstance.registerExporter(exporter)` after construction.
 *
 * Minimum supported Mastra version: 1.20.0 (when `Mastra.prototype.register`
 * `Exporter` and `ObservabilityInstance.registerExporter` were added). The
 * exporter itself works as a manual integration on any Mastra version that
 * accepts an `ObservabilityExporter`.
 */

import { debugLogger } from "../debug-logger";
import {
  _internalGetGlobalState,
  _internalSetInitialState,
  currentSpan,
  startSpan,
  type StartSpanArgs,
  type Span,
} from "../logger";
import { SpanTypeAttribute, isObject } from "../util";

/** Subset of Mastra's `AnyExportedSpan` that we consume — vendored to avoid a
 *  hard dependency on `@mastra/core` types. Fields match `SpanData<SpanType>`
 *  in `@mastra/core/observability`. */
interface MastraExportedSpan {
  id: string;
  traceId: string;
  name: string;
  type: string;
  startTime: Date | string | number;
  endTime?: Date | string | number;
  parentSpanId?: string;
  isRootSpan?: boolean;
  isEvent?: boolean;
  isInternal?: boolean;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];
  input?: unknown;
  output?: unknown;
  errorInfo?: {
    message: string;
    id?: string;
    name?: string;
    stack?: string;
    domain?: string;
    category?: string;
    details?: Record<string, unknown>;
  };
  requestContext?: Record<string, unknown>;
}

interface MastraTracingEvent {
  type: "span_started" | "span_updated" | "span_ended";
  exportedSpan: MastraExportedSpan;
}

/** Subset of the `ObservabilityExporter` contract from `@mastra/core`. */
export interface MastraObservabilityExporter {
  name: string;
  init?(options: unknown): void;
  __setLogger?(logger: unknown): void;
  exportTracingEvent(event: MastraTracingEvent): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const MASTRA_BRAINTRUST_EXPORTER_NAME = "braintrust";

/** Mastra span types we explicitly route to Braintrust span types. Everything
 *  else falls back to `function` for non-event, `task` for root.
 *  Source: @mastra/core SpanType enum (dist/observability/types/tracing.d.ts). */
const SPAN_TYPE_MAP: Record<string, SpanTypeAttribute> = {
  agent_run: SpanTypeAttribute.TASK,
  model_generation: SpanTypeAttribute.LLM,
  model_step: SpanTypeAttribute.LLM,
  model_chunk: SpanTypeAttribute.LLM,
  tool_call: SpanTypeAttribute.TOOL,
  mcp_tool_call: SpanTypeAttribute.TOOL,
  workflow_run: SpanTypeAttribute.TASK,
  workflow_step: SpanTypeAttribute.FUNCTION,
  workflow_conditional: SpanTypeAttribute.FUNCTION,
  workflow_conditional_eval: SpanTypeAttribute.FUNCTION,
  workflow_parallel: SpanTypeAttribute.FUNCTION,
  workflow_loop: SpanTypeAttribute.FUNCTION,
  workflow_sleep: SpanTypeAttribute.FUNCTION,
  workflow_wait_event: SpanTypeAttribute.FUNCTION,
  memory_operation: SpanTypeAttribute.FUNCTION,
  workspace_action: SpanTypeAttribute.FUNCTION,
  rag_ingestion: SpanTypeAttribute.TASK,
  rag_embedding: SpanTypeAttribute.LLM,
  rag_vector_operation: SpanTypeAttribute.FUNCTION,
  rag_action: SpanTypeAttribute.FUNCTION,
  graph_action: SpanTypeAttribute.FUNCTION,
  scorer_run: SpanTypeAttribute.SCORE,
  scorer_step: SpanTypeAttribute.SCORE,
  processor_run: SpanTypeAttribute.FUNCTION,
  generic: SpanTypeAttribute.FUNCTION,
};

function spanTypeFor(mastraType: string): SpanTypeAttribute {
  return SPAN_TYPE_MAP[mastraType] ?? SpanTypeAttribute.FUNCTION;
}

function epochSeconds(
  value: Date | string | number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/** Pull token usage from `MODEL_GENERATION` / `MODEL_STEP` attributes into the
 *  shape Braintrust's `metrics` field expects. */
function modelMetrics(
  attributes: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (!isObject(attributes)) return undefined;
  const usage = isObject(attributes.usage) ? attributes.usage : undefined;
  if (!usage) return undefined;

  const out: Record<string, number> = {};
  if (typeof usage.inputTokens === "number")
    out.prompt_tokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number")
    out.completion_tokens = usage.outputTokens;
  if (
    typeof usage.inputTokens === "number" &&
    typeof usage.outputTokens === "number"
  ) {
    out.tokens = usage.inputTokens + usage.outputTokens;
  }

  const inputDetails = isObject(usage.inputDetails)
    ? usage.inputDetails
    : undefined;
  const outputDetails = isObject(usage.outputDetails)
    ? usage.outputDetails
    : undefined;
  if (inputDetails && typeof inputDetails.cacheRead === "number") {
    out.prompt_cached_tokens = inputDetails.cacheRead;
  }
  if (inputDetails && typeof inputDetails.cacheWrite === "number") {
    out.prompt_cache_creation_tokens = inputDetails.cacheWrite;
  }
  if (outputDetails && typeof outputDetails.reasoning === "number") {
    out.completion_reasoning_tokens = outputDetails.reasoning;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Compute time-to-first-token for streaming model spans. Mastra records
 * `completionStartTime` (the wall-clock time the first token/chunk arrived) in
 * a `MODEL_GENERATION` / `MODEL_INFERENCE` span's attributes; Braintrust
 * expects `time_to_first_token` as the elapsed **seconds** between the span
 * start and that first token. Returns undefined for non-streaming spans (no
 * `completionStartTime`) or when either timestamp is unusable.
 */
function timeToFirstTokenSeconds(
  attributes: Record<string, unknown> | undefined,
  spanStartSeconds: number | undefined,
): number | undefined {
  if (!isObject(attributes)) return undefined;
  if (spanStartSeconds === undefined) return undefined;
  const raw = attributes.completionStartTime;
  const completionStart =
    raw instanceof Date || typeof raw === "string" || typeof raw === "number"
      ? epochSeconds(raw)
      : undefined;
  if (completionStart === undefined) return undefined;
  const ttft = completionStart - spanStartSeconds;
  return Number.isFinite(ttft) && ttft >= 0 ? ttft : undefined;
}

/** Build the metadata payload Braintrust shows on the span, merging
 *  Mastra's own `metadata`, `attributes` (sans usage), and entity fields. */
function buildMetadata(exported: MastraExportedSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (exported.entityId !== undefined) out.entity_id = exported.entityId;
  if (exported.entityName !== undefined) out.entity_name = exported.entityName;
  if (exported.entityType !== undefined) out.entity_type = exported.entityType;
  if (exported.metadata && isObject(exported.metadata)) {
    Object.assign(out, exported.metadata);
  }
  if (exported.attributes && isObject(exported.attributes)) {
    for (const [key, value] of Object.entries(exported.attributes)) {
      if (key === "usage") continue; // surfaced via metrics
      // `completionStartTime` is also surfaced as the `time_to_first_token`
      // metric, but we keep the raw value in metadata too: earlier released
      // versions exposed it there, so dropping it would be a backward-
      // incompatible removal of a consumer-visible field.
      if (value !== undefined) out[key] = value;
    }
  }
  if (exported.tags && exported.tags.length > 0) {
    out.tags = exported.tags;
  }
  if (exported.requestContext && isObject(exported.requestContext)) {
    out.request_context = exported.requestContext;
  }
  return out;
}

type SpanRecord = {
  span: Span;
  hasLoggedInput: boolean;
};

/**
 * Translates Mastra `TracingEvent`s into Braintrust spans.
 *
 * Construct one instance per `Observability` config (Mastra holds onto it for
 * the process lifetime). Safe to register on multiple Mastra instances, but
 * each instance maintains its own span map keyed by Mastra `spanId`.
 */
export class BraintrustObservabilityExporter implements MastraObservabilityExporter {
  public readonly name = MASTRA_BRAINTRUST_EXPORTER_NAME;

  private readonly spans = new Map<string, SpanRecord>();
  // Captured at the first SPAN_STARTED event. Mastra's observability bus may
  // dispatch later events outside the user's AsyncLocalStorage context, where
  // `currentSpan()` returns NOOP_SPAN — which would make our `startSpan()`
  // calls go to a no-op logger and silently drop. Anchoring on the parent
  // we observe while still in-context keeps the whole Mastra subtree under
  // the user's traced scenario.
  private capturedParent: Span | undefined;

  constructor() {
    // The auto-instrumentations bundle and the main braintrust bundle each
    // have their own module-scoped `_globalState`. The main bundle initializes
    // state via `configureNode`; this call rehydrates our bundle's copy from
    // the shared `globalThis[Symbol.for("braintrust-state")]` so subsequent
    // `currentSpan()` / `startSpan()` calls hit a real state, not undefined.
    _internalSetInitialState();
  }

  async exportTracingEvent(event: MastraTracingEvent): Promise<void> {
    const exported = event.exportedSpan;
    // Mastra emits internal/event spans that don't model user work; skip them
    // so we don't pollute the trace with framework plumbing.
    if (exported.isInternal === true) return;

    try {
      switch (event.type) {
        case "span_started":
          this.onStart(exported);
          break;
        case "span_updated":
          this.onUpdate(exported);
          break;
        case "span_ended":
          this.onEnd(exported);
          break;
      }
    } catch (err) {
      // Never let exporter failures escape into the Mastra pipeline — they'd
      // bubble up into user code paths and break agent runs.
      logExporterError(err);
    }
  }

  async flush(): Promise<void> {
    const state = _internalGetGlobalState();
    if (state) {
      await state.bgLogger().flush();
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
    this.spans.clear();
  }

  private onStart(exported: MastraExportedSpan): void {
    if (this.spans.has(exported.id)) return; // duplicate start

    const args: StartSpanArgs = {
      name: exported.name,
      spanAttributes: { type: spanTypeFor(exported.type) },
      startTime: epochSeconds(exported.startTime),
      // Use the Mastra span id as the Braintrust row id so that
      // `logFeedback({ id: <mastra span id> })` (and Mastra's score events)
      // attach to the right row. Without this, `SpanImpl` auto-generates a
      // row id (`this._id = eventId ?? idGenerator.getSpanId()`) that no
      // external caller could know.
      event: { id: exported.id },
    };

    const parentRecord = exported.parentSpanId
      ? this.spans.get(exported.parentSpanId)
      : undefined;

    // Capture the user's current span on the very first event we see; later
    // events from Mastra's bus may run outside that AsyncLocalStorage scope.
    if (!this.capturedParent) {
      const probe = currentSpan();
      if (probe && (probe as Span).spanId) {
        this.capturedParent = probe;
      }
    }

    const span = parentRecord
      ? parentRecord.span.startSpan(args)
      : this.capturedParent
        ? this.capturedParent.startSpan(args)
        : startSpan(args);

    const record: SpanRecord = { span, hasLoggedInput: false };
    this.logPayload(record, exported);
    this.spans.set(exported.id, record);

    if (exported.isEvent === true) {
      // Event spans (Mastra's "this happened at a point in time" model) have
      // no endTime — end them immediately so they show up but don't leak.
      span.end({ endTime: args.startTime });
      this.spans.delete(exported.id);
    }
  }

  private onUpdate(exported: MastraExportedSpan): void {
    const record = this.spans.get(exported.id);
    if (!record) return;
    this.logPayload(record, exported);
  }

  private onEnd(exported: MastraExportedSpan): void {
    const record = this.spans.get(exported.id);
    if (!record) return;

    this.logPayload(record, exported);

    if (exported.errorInfo) {
      record.span.log({
        error:
          exported.errorInfo.message ||
          exported.errorInfo.name ||
          "Unknown Mastra error",
      });
    }

    record.span.end({ endTime: epochSeconds(exported.endTime) });
    this.spans.delete(exported.id);
  }

  private logPayload(record: SpanRecord, exported: MastraExportedSpan): void {
    const event: Record<string, unknown> = {};

    if (exported.input !== undefined) {
      event.input = exported.input;
      record.hasLoggedInput = true;
    }
    if (exported.output !== undefined) {
      event.output = exported.output;
    }

    const metadata = buildMetadata(exported);
    if (Object.keys(metadata).length > 0) {
      event.metadata = metadata;
    }

    const metrics = modelMetrics(exported.attributes);
    const ttft = timeToFirstTokenSeconds(
      exported.attributes,
      epochSeconds(exported.startTime),
    );
    if (metrics || ttft !== undefined) {
      event.metrics = {
        ...(metrics ?? {}),
        ...(ttft !== undefined ? { time_to_first_token: ttft } : {}),
      };
    }

    if (Object.keys(event).length > 0) {
      record.span.log(event);
    }
  }
}

function logExporterError(err: unknown): void {
  debugLogger.warn("Mastra exporter failure:", err);
}

/**
 * @deprecated Mastra is now instrumented through its own `ObservabilityExporter`
 * contract instead of by wrapping the agent. This function does nothing and
 * will be removed in the next major release.
 *
 * To capture Mastra spans in Braintrust, do one of:
 *
 * - **Auto-instrumentation**: run your app with
 *   `node --import braintrust/hook.mjs`. The loader installs
 *   `BraintrustObservabilityExporter` into every `new Mastra(...)`
 *   automatically.
 * - **Manual wiring**: pass the exporter yourself:
 *
 *   ```ts
 *   import { Mastra } from "@mastra/core";
 *   import { Observability } from "@mastra/observability";
 *   import { BraintrustObservabilityExporter } from "braintrust";
 *
 *   const mastra = new Mastra({
 *     observability: new Observability({
 *       configs: {
 *         default: {
 *           serviceName: "my-service",
 *           exporters: [new BraintrustObservabilityExporter()],
 *         },
 *       },
 *     }),
 *   });
 *   ```
 */
export function wrapMastraAgent<T>(
  agent: T,
  _options?: { name?: string; span_name?: string },
): T {
  return agent;
}
