import { SpanComponentsV4, SpanObjectTypeV3 } from "braintrust/util";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  context,
  Context,
  trace,
  TraceFlags,
  propagation,
  Span,
} from "@opentelemetry/api";
import {
  SpanProcessor,
  ReadableSpan,
  BatchSpanProcessor,
  type Span as SDKSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  IDGenerator,
  currentSpan,
  registerOtelFlush,
  type Span as BraintrustSpan,
} from "braintrust";

interface ExportResult {
  code: number;
  error?: Error;
}

const FILTER_PREFIXES = [
  "gen_ai.",
  "braintrust.",
  "llm.",
  "ai.",
  "traceloop.",
] as const;

/**
 * Custom filter function type for span filtering.
 * @param span - The span to evaluate
 * @returns true to definitely keep, false to definitely drop, null/undefined to not influence the decision
 */
type CustomSpanFilter = (span: ReadableSpan) => boolean | null | undefined;

/**
 * Type guard to check if a span has the attributes property (i.e., is a ReadableSpan).
 */
function isReadableSpan(span: Span | ReadableSpan): span is ReadableSpan {
  return "attributes" in span;
}

/**
 * Returns true if the span is a root span (no parent).
 * Checks both parentSpanId (OTel 1.x) and parentSpanContext (OTel 2.x).
 */
export function isRootSpan(span: ReadableSpan): boolean {
  const hasParent =
    ("parentSpanId" in span && (span as any).parentSpanId) ||
    ("parentSpanContext" in span && (span as any).parentSpanContext);
  return !hasParent;
}

/**
 * Returns true if the span is an AI span (name or attribute matches AI prefixes).
 */
function isAISpan(span: ReadableSpan): boolean {
  if (FILTER_PREFIXES.some((prefix) => span.name.startsWith(prefix))) {
    return true;
  }
  const attributes = span.attributes;
  if (attributes) {
    const attributeNames = Object.keys(attributes);
    if (
      attributeNames.some((name) =>
        FILTER_PREFIXES.some((prefix) => name.startsWith(prefix)),
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A span processor that filters spans to only export filtered telemetry.
 *
 * Only filtered spans and root spans will be forwarded to the inner processor.
 * This dramatically reduces telemetry volume while preserving important observability.
 *
 * @example
 * ```typescript
 * const processor = new AISpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()));
 * const provider = new TracerProvider();
 * provider.addSpanProcessor(processor);
 * ```
 */
export class AISpanProcessor {
  private readonly processor: SpanProcessor;
  private readonly customFilter: CustomSpanFilter;

  /**
   * Initialize the filter span processor.
   *
   * @param processor - The wrapped span processor that will receive filtered spans
   * @param customFilter - Optional function that takes a span and returns:
   *                      true to keep, false to drop,
   *                      null/undefined to not influence the decision
   */
  constructor(processor: SpanProcessor, customFilter?: CustomSpanFilter) {
    this.processor = processor;
    this.customFilter = customFilter || isAISpan;
  }

  /**
   * Forward span start events to the inner processor.
   */
  onStart(span: SDKSpan, parentContext: Context): void {
    this.processor.onStart(span, parentContext);
  }

  /**
   * Apply filtering logic and conditionally forward span end events.
   */
  onEnd(span: ReadableSpan): void {
    const shouldKeep = this.shouldKeepFilteredSpan(span);
    if (shouldKeep) {
      this.processor.onEnd(span);
    }
  }

  /**
   * Shutdown the inner processor.
   */
  shutdown(): Promise<void> {
    return this.processor.shutdown();
  }

  /**
   * Force flush the inner processor.
   */
  forceFlush(): Promise<void> {
    return this.processor.forceFlush();
  }

  /**
   * Determine if a span should be kept based on filtering criteria.
   *
   * Keep spans if:
   * 1. Custom filter returns true/false (if provided)
   * 2. Span name starts with 'gen_ai.', 'braintrust.', 'llm.', 'ai.', or 'traceloop.'
   * 3. Any attribute name starts with those prefixes
   */
  private shouldKeepFilteredSpan(span: ReadableSpan): boolean {
    if (!span) {
      return false;
    }
    const result = this.customFilter(span);
    if (typeof result === "boolean") {
      return result;
    }
    // Fallback: if customFilter returns undefined or null, use isAISpan
    return isAISpan(span);
  }
}

interface BraintrustSpanProcessorOptions {
  /**
   * Braintrust API key. If not provided, will use BRAINTRUST_API_KEY environment variable.
   */
  apiKey?: string;
  /**
   * Braintrust API URL. If not provided, will use BRAINTRUST_API_URL environment variable. Defaults to https://api.braintrust.dev
   */
  apiUrl?: string;
  /**
   * Braintrust parent project name (e.g., "project_name:otel_examples"). If not provided, will use BRAINTRUST_PARENT environment variable.
   */
  parent?: string;
  /**
   * Whether to enable AI span filtering. Defaults to false.
   */
  filterAISpans?: boolean;
  /**
   * Custom filter function for span filtering
   */
  customFilter?: CustomSpanFilter;
  /**
   * Additional headers to send with telemetry data
   */
  headers?: Record<string, string>;
  /**
   * @internal
   * Internal option for dependency injection during testing.
   * If provided, this processor will be used instead of creating an OTLP exporter.
   */
  _spanProcessor?: SpanProcessor;
}

/**
 * A span processor that sends OpenTelemetry spans to Braintrust.
 *
 * This processor uses a BatchSpanProcessor and an OTLP exporter configured
 * to send data to Braintrust's telemetry endpoint. Span filtering is disabled
 * by default but can be enabled with the filterAISpans option.
 *
 * Environment Variables:
 * - BRAINTRUST_API_KEY: Your Braintrust API key
 * - BRAINTRUST_PARENT: Parent identifier (e.g., "project_name:test")
 * - BRAINTRUST_API_URL: Base URL for Braintrust API (defaults to https://api.braintrust.dev)
 *
 * @example
 * ```typescript
 * const processor = new BraintrustSpanProcessor({
 *   apiKey: 'your-api-key',
 *   apiUrl: 'https://api.braintrust.dev'
 * });
 * const provider = new TracerProvider();
 * provider.addSpanProcessor(processor);
 * ```
 *
 * @example With span filtering enabled:
 * ```typescript
 * const processor = new BraintrustSpanProcessor({
 *   apiKey: 'your-api-key',
 *   filterAISpans: true
 * });
 * ```
 *
 * @example Using environment variables:
 * ```typescript
 * // Set environment variables:
 * // BRAINTRUST_API_KEY=your-api-key
 * // BRAINTRUST_PARENT=project_name:test
 * // BRAINTRUST_API_URL=https://api.braintrust.dev
 * const processor = new BraintrustSpanProcessor();
 * ```
 */
export class BraintrustSpanProcessor implements SpanProcessor {
  private readonly processor: SpanProcessor;
  private readonly aiSpanProcessor: SpanProcessor;

  constructor(options: BraintrustSpanProcessorOptions = {}) {
    // If a processor is injected (for testing), use it directly
    if (options._spanProcessor) {
      this.processor = options._spanProcessor;
      // Apply filtering if requested
      if (options.filterAISpans === true) {
        this.aiSpanProcessor = new AISpanProcessor(
          this.processor,
          options.customFilter,
        );
      } else {
        this.aiSpanProcessor = this.processor;
      }
      // Register forceFlush callback with main SDK
      registerOtelFlush(() => this.forceFlush());
      return;
    }

    // Get API key from options or environment
    const apiKey = options.apiKey || process.env.BRAINTRUST_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Braintrust API key is required. Set BRAINTRUST_API_KEY environment variable or pass apiKey option.",
      );
    }

    // Get API URL from options or environment
    let apiUrl =
      options.apiUrl ||
      process.env.BRAINTRUST_API_URL ||
      "https://api.braintrust.dev";

    // Ensure apiUrl ends with / for proper joining
    if (!apiUrl.endsWith("/")) {
      apiUrl += "/";
    }

    // Get parent from options or environment
    let parent = options.parent || process.env.BRAINTRUST_PARENT;

    // Default parent if not provided
    if (!parent) {
      parent = "project_name:default-otel-project";
      console.info(
        `No parent specified, using default: ${parent}. ` +
          "Configure with BRAINTRUST_PARENT environment variable or parent parameter.",
      );
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "x-bt-parent": parent,
      ...options.headers,
    };

    const baseExporter = new OTLPTraceExporter({
      url: new URL("otel/v1/traces", apiUrl).href,
      headers,
    });

    const exporter = baseExporter;

    this.processor = new BatchSpanProcessor(exporter);
    // Conditionally wrap with filtering based on filterAISpans flag
    if (options.filterAISpans === true) {
      // Only enable filtering if explicitly requested
      this.aiSpanProcessor = new AISpanProcessor(
        this.processor,
        options.customFilter,
      );
    } else {
      // Use the batch processor directly without filtering (default behavior)
      this.aiSpanProcessor = this.processor;
    }

    // Register forceFlush callback with main SDK so OTEL spans get flushed
    // when scorers call trace.getSpans() and need to query BTQL
    registerOtelFlush(() => this.forceFlush());
  }

  onStart(span: SDKSpan, parentContext: Context): void {
    try {
      let parentValue: string | undefined;

      // Priority 1: Check if braintrust.parent is in current OTEL context
      if (context) {
        const currentContext = context.active();
        const contextValue = currentContext.getValue?.(
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
          "braintrust.parent" as any,
        );
        if (typeof contextValue === "string") {
          parentValue = contextValue;
        }

        // Priority 2: Check if parent_context has braintrust.parent (backup)
        if (!parentValue && parentContext) {
          const parentContextValue =
            typeof parentContext.getValue === "function"
              ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
                parentContext.getValue("braintrust.parent" as any)
              : undefined;
          if (typeof parentContextValue === "string") {
            parentValue = parentContextValue;
          }
        }

        // Priority 3: Check if parent OTEL span has braintrust.parent attribute
        if (!parentValue && parentContext) {
          parentValue = this._getParentOtelBraintrustParent(parentContext);
        }

        // Priority 4: Check the active Braintrust span directly
        if (!parentValue) {
          const braintrustSpan = currentSpan();
          if (braintrustSpan.rootSpanId && braintrustSpan.spanId) {
            parentValue = getOtelParentFromSpan(braintrustSpan);
          }
        }

        // Set the attribute if we found a parent value
        if (parentValue) {
          span.setAttributes?.({ "braintrust.parent": parentValue });
        }
      }
    } catch {
      // If there's an exception, just don't set braintrust.parent
    }

    this.aiSpanProcessor.onStart(span, parentContext);
  }

  private _getParentOtelBraintrustParent(
    parentContext: Context,
  ): string | undefined {
    const currentSpan = trace?.getSpan(parentContext);

    if (
      currentSpan &&
      typeof currentSpan === "object" &&
      "attributes" in currentSpan &&
      typeof currentSpan.attributes === "object"
    ) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const attributes = currentSpan.attributes as Record<string, unknown>;
      const parentAttr = attributes["braintrust.parent"];
      return typeof parentAttr === "string" ? parentAttr : undefined;
    }

    return undefined;
  }

  onEnd(span: ReadableSpan): void {
    this.aiSpanProcessor.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.aiSpanProcessor.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.aiSpanProcessor.forceFlush();
  }
}

/**
 * Create an OTEL context from a Braintrust span export string.
 *
 * Used for distributed tracing scenarios where a Braintrust span in one service
 * needs to be the parent of an OTEL span in another service.
 *
 * @param exportStr - The string returned from span.export()
 * @returns OTEL context that can be used when creating child spans
 *
 * @example
 * ```typescript
 * // Service A: Create BT span and export
 * const span = logger.startSpan({ name: "service-a" });
 * const exportStr = await span.export();
 * // Send exportStr to Service B (e.g., via HTTP header)
 *
 * // Service B: Import context and create OTEL child
 * import * as api from '@opentelemetry/api';
 * const ctx = contextFromSpanExport(exportStr);
 * await api.context.with(ctx, async () => {
 *   await tracer.startActiveSpan("service-b", async (span) => {
 *     // This span is now a child of the Service A span
 *     span.end();
 *   });
 * });
 * ```
 */
export function contextFromSpanExport(exportStr: string): unknown {
  // Parse the export string
  const components = SpanComponentsV4.fromStr(exportStr);

  // Get trace and span IDs (already in hex format)
  const traceIdHex = components.data.root_span_id; // 32 hex chars
  const spanIdHex = components.data.span_id; // 16 hex chars

  if (!traceIdHex || !spanIdHex) {
    throw new Error(
      "Export string must contain root_span_id and span_id for distributed tracing",
    );
  }

  // Create SpanContext marked as remote (critical for distributed tracing)
  const spanContext = {
    traceId: traceIdHex,
    spanId: spanIdHex,
    isRemote: true,
    traceFlags: TraceFlags?.SAMPLED ?? 1, // SAMPLED flag
  };

  // Create NonRecordingSpan using wrapSpanContext and set in context
  const nonRecordingSpan = trace.wrapSpanContext(spanContext);
  let ctx = trace.setSpan(context.active(), nonRecordingSpan);

  // Construct braintrust.parent identifier
  const braintrustParent = getBraintrustParent(
    components.data.object_type,
    components.data.object_id,
    components.data.compute_object_metadata_args,
  );

  // Set braintrust.parent in baggage so it propagates automatically
  if (braintrustParent) {
    try {
      // Try to set baggage if available
      if (propagation) {
        const baggage =
          propagation.getBaggage(ctx) || propagation.createBaggage();
        ctx = propagation.setBaggage(
          ctx,
          baggage.setEntry("braintrust.parent", {
            value: braintrustParent,
          }),
        );
      }
    } catch (error) {
      console.error(
        "Failed to set braintrust.parent in baggage during context import:",
        error,
      );
    }
  }

  return ctx;
}

/**
 * Construct a braintrust.parent identifier string from span components.
 *
 * @param objectType - Type of parent object (PROJECT_LOGS or EXPERIMENT)
 * @param objectId - Resolved object ID (project_id or experiment_id)
 * @param computeArgs - Optional dict with project_name/project_id for unresolved cases
 * @returns String like "project_id:abc", "project_name:my-proj", "experiment_id:exp-123", or undefined
 */
function getBraintrustParent(
  objectType: number,
  objectId?: string | null,
  computeArgs?: Record<string, unknown> | null,
): string | undefined {
  if (!objectType) {
    return undefined;
  }

  if (objectType === SpanObjectTypeV3.PROJECT_LOGS) {
    if (objectId) {
      return `project_id:${objectId}`;
    } else if (computeArgs) {
      const projectId = computeArgs["project_id"];
      const projectName = computeArgs["project_name"];
      if (typeof projectId === "string") {
        return `project_id:${projectId}`;
      } else if (typeof projectName === "string") {
        return `project_name:${projectName}`;
      }
    }
  } else if (objectType === SpanObjectTypeV3.EXPERIMENT) {
    if (objectId) {
      return `experiment_id:${objectId}`;
    } else if (computeArgs) {
      const experimentId = computeArgs["experiment_id"];
      if (typeof experimentId === "string") {
        return `experiment_id:${experimentId}`;
      }
    }
  }

  return undefined;
}

/**
 * Get the OTEL parent string from a Braintrust span.
 * This is used to set the braintrust.parent attribute in OTEL contexts.
 *
 * @param span - Braintrust Span object
 * @returns A string like "project_id:X", "project_name:X", or "experiment_id:X", or undefined if no parent
 */
export function getOtelParentFromSpan(
  span: BraintrustSpan,
): string | undefined {
  const parent = span.getParentInfo();

  if (!parent || !parent.objectType || !parent.objectId) {
    return undefined;
  }

  try {
    if (parent.objectType === SpanObjectTypeV3.PROJECT_LOGS) {
      const syncResult = parent.objectId.getSync();
      const id = syncResult?.value;
      const args = parent.computeObjectMetadataArgs;

      if (id) {
        return `project_id:${id}`;
      }

      const projectName = args?.project_name;
      if (typeof projectName === "string") {
        return `project_name:${projectName}`;
      }
    } else if (parent.objectType === SpanObjectTypeV3.EXPERIMENT) {
      const syncResult = parent.objectId.getSync();
      const id = syncResult?.value;

      // Debug details for experiment
      // eslint-disable-next-line no-console
      console.debug("[getOtelParentFromSpan] EXPERIMENT", { id });

      if (id) {
        // eslint-disable-next-line no-console
        console.debug(
          "[getOtelParentFromSpan] EXPERIMENT using experiment_id",
          { id },
        );
        return `experiment_id:${id}`;
      }
    }
  } catch (e) {
    // Debug: unexpected error reading parent info
    // eslint-disable-next-line no-console
    console.warn("[getOtelParentFromSpan] error extracting parent", e);
  }
  return undefined;
}

/**
 * A trace exporter that sends OpenTelemetry spans to Braintrust.
</text>

 *
 * This exporter wraps the standard OTLP trace exporter and can be used with
 * any OpenTelemetry setup, including @vercel/otel's registerOTel function,
 * NodeSDK, or custom tracer providers. It can optionally filter spans to
 * only send AI-related telemetry.
 *
 * Environment Variables:
 * - BRAINTRUST_API_KEY: Your Braintrust API key
 * - BRAINTRUST_PARENT: Parent identifier (e.g., "project_name:test")
 * - BRAINTRUST_API_URL: Base URL for Braintrust API (defaults to https://api.braintrust.dev)
 *
 * @example With @vercel/otel:
 * ```typescript
 * import { registerOTel } from '@vercel/otel';
 * import { BraintrustExporter } from '@braintrust/otel';
 *
 * export function register() {
 *   registerOTel({
 *     serviceName: 'my-app',
 *     traceExporter: new BraintrustExporter({
 *       filterAISpans: true,
 *     }),
 *   });
 * }
 * ```
 *
 * @example With NodeSDK:
 * ```typescript
 * import { NodeSDK } from '@opentelemetry/sdk-node';
 * import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
 * import { BraintrustExporter } from 'braintrust';
 *
 * const sdk = new NodeSDK({
 *   spanProcessors: [
 *     new BatchSpanProcessor(new BraintrustExporter({
 *       apiKey: 'your-api-key',
 *       parent: 'project_name:test'
 *     }))
 *   ]
 * });
 * ```
 */
export class BraintrustExporter {
  private readonly processor: BraintrustSpanProcessor;
  private readonly spans: ReadableSpan[] = [];
  private readonly callbacks: Array<(result: unknown) => void> = [];

  constructor(options: BraintrustSpanProcessorOptions = {}) {
    // Use BraintrustSpanProcessor under the hood
    this.processor = new BraintrustSpanProcessor(options);
  }

  /**
   * Export spans to Braintrust by simulating span processor behavior.
   */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    try {
      // Process each span through the processor
      spans.forEach((span) => {
        this.processor.onEnd(span);
      });

      // Force flush to ensure spans are sent
      this.processor
        .forceFlush()
        .then(() => {
          resultCallback({ code: 0 }); // SUCCESS
        })
        .catch((error) => {
          const errorObj =
            error instanceof Error ? error : new Error(String(error));
          resultCallback({ code: 1, error: errorObj }); // FAILURE
        });
    } catch (error) {
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      resultCallback({ code: 1, error: errorObj }); // FAILURE
    }
  }

  /**
   * Shutdown the exporter.
   */
  shutdown(): Promise<void> {
    return this.processor.shutdown();
  }

  /**
   * Force flush the exporter.
   */
  forceFlush(): Promise<void> {
    return this.processor.forceFlush();
  }
}

/**
 * Add braintrust.parent to OTEL baggage.
 *
 * This ensures that when using propagation inject() for distributed tracing,
 * the braintrust.parent will be propagated via baggage to downstream services.
 *
 * @param parent - Braintrust parent identifier (e.g., "project_name:my-project",
 *                 "project_id:abc123", "experiment_id:exp-456")
 * @param ctx - Optional OTEL context to use. If not provided, uses current context.
 * @returns Updated context with braintrust.parent in baggage
 *
 * @example
 * ```typescript
 * import { addParentToBaggage } from "@braintrust/otel";
 * import { propagation } from "@opentelemetry/api";
 *
 * // Set braintrust.parent in baggage
 * addParentToBaggage("project_name:my-project");
 *
 * // Export headers (will include braintrust.parent in baggage)
 * const headers = {};
 * propagation.inject(context.active(), headers);
 * ```
 */
export function addParentToBaggage(parent: string, ctx?: Context): Context {
  try {
    if (!propagation) {
      console.error("OTEL propagation API not available");
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return (ctx || context.active()) as Context;
    }

    const currentCtx = ctx || context.active();
    const baggage =
      propagation.getBaggage(currentCtx) || propagation.createBaggage();
    return propagation.setBaggage(
      currentCtx,
      baggage.setEntry("braintrust.parent", { value: parent }),
    );
  } catch (error) {
    console.error("Failed to add braintrust.parent to baggage:", error);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return (ctx || context.active()) as Context;
  }
}

/**
 * Copy braintrust.parent from span attribute to OTEL baggage.
 *
 * BraintrustSpanProcessor automatically sets braintrust.parent as a span attribute
 * when OTEL spans are created within Braintrust contexts. This function copies that
 * attribute to OTEL baggage so it propagates when using inject() for distributed tracing.
 *
 * @param span - OTEL span that has braintrust.parent attribute set
 * @param ctx - Optional OTEL context to use. If not provided, uses current context.
 * @returns Updated context with braintrust.parent in baggage, or undefined if attribute not found
 *
 * @example
 * ```typescript
 * import { otel } from "braintrust";
 * import { propagation } from "@opentelemetry/api";
 *
 * tracer.startActiveSpan("service_b", (span) => {
 *   // Copy braintrust.parent from span attribute to baggage
 *   otel.addSpanParentToBaggage(span);
 *
 *   // Export headers (will include braintrust.parent in baggage)
 *   const headers = {};
 *   propagation.inject(context.active(), headers);
 *   span.end();
 * });
 * ```
 */
export function addSpanParentToBaggage(
  span: Span | ReadableSpan,
  ctx?: Context,
): Context | undefined {
  if (!span || !isReadableSpan(span)) {
    console.warn("addSpanParentToBaggage: span has no attributes");
    return undefined;
  }

  const parentValue = span.attributes["braintrust.parent"];
  if (!parentValue || typeof parentValue !== "string") {
    console.warn(
      "addSpanParentToBaggage: braintrust.parent attribute not found. " +
        "Ensure BraintrustSpanProcessor is configured or span is created within Braintrust context.",
    );
    return undefined;
  }

  return addParentToBaggage(parentValue, ctx);
}

/**
 * Extract a Braintrust-compatible parent string from W3C Trace Context headers.
 *
 * This converts OTEL trace context headers (traceparent/baggage) into a format
 * that can be passed as the 'parent' parameter to Braintrust's traced() method.
 *
 * @param headers - Dictionary with 'traceparent' and optionally 'baggage' keys
 * @returns Braintrust V4 export string that can be used as parent parameter,
 *          or undefined if no valid span context is found or braintrust.parent is missing.
 *
 * @example
 * ```typescript
 * import { initLogger } from "braintrust";
 * import { parentFromHeaders } from "@braintrust/otel";
 *
 * // Service C receives headers from Service B
 * const headers = { traceparent: '00-trace_id-span_id-01', baggage: '...' };
 * const parent = parentFromHeaders(headers);
 *
 * const logger = initLogger({ projectName: "my-project" });
 * await logger.traced(async (span) => {
 *   span.log({ input: "BT span as child of OTEL parent" });
 * }, { name: "service_c", parent });
 * ```
 */
export function parentFromHeaders(
  headers: Record<string, string>,
): string | undefined {
  try {
    if (!propagation) {
      console.error("OTEL propagation API not available");
      return undefined;
    }

    // Extract context from headers using W3C Trace Context propagator
    // This parses both traceparent and baggage headers
    const ctx = propagation.extract(context.active(), headers);

    // Get span context directly from the extracted context
    const spanContext = trace.getSpanContext(ctx);
    if (!spanContext) {
      console.error("parentFromHeaders: No valid span context in headers");
      return undefined;
    }

    // Get trace_id and span_id from span context
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const traceIdHex = spanContext.traceId as string;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const spanIdHex = spanContext.spanId as string;

    // Validate trace_id and span_id are not all zeros
    if (
      !traceIdHex ||
      typeof traceIdHex !== "string" ||
      traceIdHex === "00000000000000000000000000000000"
    ) {
      console.error("parentFromHeaders: Invalid trace_id (all zeros)");
      return undefined;
    }
    if (
      !spanIdHex ||
      typeof spanIdHex !== "string" ||
      spanIdHex === "0000000000000000"
    ) {
      console.error("parentFromHeaders: Invalid span_id (all zeros)");
      return undefined;
    }

    // Get braintrust.parent from baggage
    const baggage = propagation.getBaggage(ctx);
    const braintrustParent = baggage?.getEntry("braintrust.parent")?.value;

    if (!braintrustParent) {
      console.warn(
        "parentFromHeaders: braintrust.parent not found in OTEL baggage. " +
          "Cannot create Braintrust parent without project information. " +
          "Ensure the OTEL span sets braintrust.parent in baggage before exporting headers.",
      );
      return undefined;
    }

    // Parse braintrust.parent to extract object_type and object_id
    let objectType: number | undefined;
    let objectId: string | undefined;
    let computeArgs: Record<string, unknown> | undefined;

    // Parse braintrust.parent format: "project_id:abc", "project_name:xyz", or "experiment_id:123"
    if (braintrustParent.startsWith("project_id:")) {
      objectType = SpanObjectTypeV3.PROJECT_LOGS;
      objectId = braintrustParent.substring("project_id:".length);
      if (!objectId) {
        console.error(
          `parentFromHeaders: Invalid braintrust.parent format (empty project_id): ${braintrustParent}`,
        );
        return undefined;
      }
    } else if (braintrustParent.startsWith("project_name:")) {
      objectType = SpanObjectTypeV3.PROJECT_LOGS;
      const projectName = braintrustParent.substring("project_name:".length);
      if (!projectName) {
        console.error(
          `parentFromHeaders: Invalid braintrust.parent format (empty project_name): ${braintrustParent}`,
        );
        return undefined;
      }
      computeArgs = { project_name: projectName };
    } else if (braintrustParent.startsWith("experiment_id:")) {
      objectType = SpanObjectTypeV3.EXPERIMENT;
      objectId = braintrustParent.substring("experiment_id:".length);
      if (!objectId) {
        console.error(
          `parentFromHeaders: Invalid braintrust.parent format (empty experiment_id): ${braintrustParent}`,
        );
        return undefined;
      }
    } else {
      console.error(
        `parentFromHeaders: Invalid braintrust.parent format: ${braintrustParent}. ` +
          "Expected format: 'project_id:ID', 'project_name:NAME', or 'experiment_id:ID'",
      );
      return undefined;
    }

    // Create SpanComponentsV4 and export as string
    const componentsData: {
      object_type: number;
      object_id?: string | null;
      compute_object_metadata_args?: Record<string, unknown> | null;
      row_id: string;
      span_id: string;
      root_span_id: string;
    } = {
      object_type: objectType,
      row_id: "otel", // Dummy row_id to enable span_id/root_span_id fields
      span_id: spanIdHex,
      root_span_id: traceIdHex,
    };

    // Add either object_id or compute_object_metadata_args, not both
    if (computeArgs) {
      componentsData.compute_object_metadata_args = computeArgs;
    } else {
      componentsData.object_id = objectId;
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
    const components = new SpanComponentsV4(componentsData as any);

    return components.toStr();
  } catch (error) {
    console.error("parentFromHeaders: Error parsing headers:", error);
    return undefined;
  }
}

function generateHexId(bytes: number): string {
  let result = "";
  for (let i = 0; i < bytes; i++) {
    result += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return result;
}

/**
 * ID generator that generates OpenTelemetry-compatible IDs
 * Uses hex strings for compatibility with OpenTelemetry systems
 */
export class OTELIDGenerator extends IDGenerator {
  getSpanId(): string {
    // Generate 8 random bytes and convert to hex (16 characters)
    return generateHexId(8);
  }

  getTraceId(): string {
    // Generate 16 random bytes and convert to hex (32 characters)
    return generateHexId(16);
  }

  shareRootSpanId(): boolean {
    return false;
  }
}
