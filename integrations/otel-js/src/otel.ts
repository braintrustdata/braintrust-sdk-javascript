import { registerOtelFlush } from "braintrust/instrumentation";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import {
  context,
  Context,
  diag,
  trace,
  propagation,
  Span,
  type TextMapGetter,
} from "@opentelemetry/api";
import {
  SpanProcessor,
  ReadableSpan,
  BatchSpanProcessor,
  type Span as SDKSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  currentSpan,
  extractTraceContextFromHeaders,
  type PropagationContext,
  type Span as BraintrustSpan,
} from "braintrust";

declare const __BRAINTRUST_OTEL_VERSION__: string;

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

const SYSTEM_ATTRIBUTE_NAMES = new Set([
  "braintrust.parent",
  "braintrust.context_json",
]);

const braintrustW3CPropagator = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});
const traceContextGetter: TextMapGetter<Record<string, string>> = {
  keys: Object.keys,
  get: (carrier, key) => carrier[key],
};

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
    const attributeNames = Object.keys(attributes).filter(
      (name) => !SYSTEM_ATTRIBUTE_NAMES.has(name),
    );
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
   * Braintrust API key. If not provided, will use BRAINTRUST_API_KEY, then
   * the nearest .env.braintrust file in Node.js.
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
  environment?: { type?: string; name?: string };
  /**
   * @internal
   * Internal option for dependency injection during testing.
   * If provided, this processor will be used instead of creating an OTLP exporter.
   */
  _spanProcessor?: SpanProcessor;
}

const SDK_VERSION = __BRAINTRUST_OTEL_VERSION__;

function spanOriginContext(environment?: { type?: string; name?: string }) {
  return {
    span_origin: {
      name: "braintrust.sdk.javascript",
      version: SDK_VERSION,
      instrumentation: { name: "braintrust-otel-js" },
      ...(environment ? { environment } : {}),
    },
  };
}

function mergeSpanOriginContextJson(
  existingContextJson: unknown,
  environment?: { type?: string; name?: string },
): string {
  const context =
    typeof existingContextJson === "string" && existingContextJson
      ? parseContextJson(existingContextJson)
      : {};
  const existingOrigin =
    context.span_origin &&
    typeof context.span_origin === "object" &&
    !Array.isArray(context.span_origin)
      ? context.span_origin
      : {};
  return JSON.stringify({
    ...context,
    span_origin: {
      ...spanOriginContext(environment).span_origin,
      ...existingOrigin,
    },
  });
}

function parseContextJson(contextJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(contextJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function withSpanOriginAttributes(
  span: ReadableSpan,
  environment?: { type?: string; name?: string },
): ReadableSpan {
  const attributes = {
    ...span.attributes,
    "braintrust.context_json": mergeSpanOriginContextJson(
      span.attributes["braintrust.context_json"],
      environment,
    ),
  };
  return new Proxy(span, {
    get(target, prop, receiver) {
      if (prop === "attributes") return attributes;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const BRAINTRUST_ENV_SEARCH_PARENT_LIMIT = 64;

function getEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name];
  if (value?.trim()) return value;
  if (
    name !== "BRAINTRUST_API_KEY" &&
    name !== "BRAINTRUST_ENVIRONMENT_TYPE" &&
    name !== "BRAINTRUST_ENVIRONMENT_NAME"
  ) {
    return value;
  }

  if (typeof process.loadEnvFile !== "function") return undefined;

  let dir: string;
  try {
    dir = process.cwd();
  } catch {
    return undefined;
  }

  for (let depth = 0; depth <= BRAINTRUST_ENV_SEARCH_PARENT_LIMIT; depth++) {
    try {
      const separator = dir.includes("\\") ? "\\" : "/";
      process.loadEnvFile(
        `${dir}${dir.endsWith(separator) ? "" : separator}.env.braintrust`,
      );
      const fileValue = process.env[name];
      return fileValue?.trim() ? fileValue : undefined;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        return undefined;
      }
    }

    const trimmed = dir.replace(/[\\/]+$/, "");
    const separatorIndex = Math.max(
      trimmed.lastIndexOf("/"),
      trimmed.lastIndexOf("\\"),
    );
    const parent =
      separatorIndex < 0
        ? dir
        : separatorIndex === 0
          ? trimmed.slice(0, 1)
          : trimmed.slice(0, separatorIndex);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function detectEnvironment(explicit?: {
  type?: string;
  name?: string;
}): { type?: string; name?: string } | undefined {
  if (explicit) return explicit;
  const envType = getEnv("BRAINTRUST_ENVIRONMENT_TYPE");
  const envName = getEnv("BRAINTRUST_ENVIRONMENT_NAME");
  if (envType || envName) {
    return {
      ...(envType ? { type: envType } : {}),
      ...(envName ? { name: envName } : {}),
    };
  }
  if (getEnv("GITHUB_ACTIONS")) return { type: "ci", name: "github_actions" };
  if (getEnv("GITLAB_CI")) return { type: "ci", name: "gitlab_ci" };
  if (getEnv("CIRCLECI")) return { type: "ci", name: "circleci" };
  if (getEnv("BUILDKITE")) return { type: "ci", name: "buildkite" };
  if (getEnv("CI")) return { type: "ci", name: "ci" };
  if (getEnv("VERCEL")) return { type: "server", name: "vercel" };
  if (getEnv("NETLIFY")) return { type: "server", name: "netlify" };
  const awsExecutionEnv = getEnv("AWS_EXECUTION_ENV");
  if (
    getEnv("ECS_CONTAINER_METADATA_URI") ||
    getEnv("ECS_CONTAINER_METADATA_URI_V4") ||
    awsExecutionEnv?.startsWith("AWS_ECS_")
  ) {
    return { type: "server", name: "ecs" };
  }
  if (
    getEnv("AWS_LAMBDA_FUNCTION_NAME") ||
    awsExecutionEnv?.startsWith("AWS_Lambda_")
  ) {
    return { type: "server", name: "aws_lambda" };
  }
  const nodeEnv = getEnv("NODE_ENV");
  if (!nodeEnv) return undefined;
  const normalizedNodeEnv = nodeEnv.toLowerCase();
  if (normalizedNodeEnv === "production" || normalizedNodeEnv === "staging") {
    return { type: "server", name: normalizedNodeEnv };
  }
  if (normalizedNodeEnv === "development" || normalizedNodeEnv === "local") {
    return { type: "local", name: normalizedNodeEnv };
  }
  return { name: nodeEnv };
}

class LazyBraintrustOTLPTraceExporter implements SpanExporter {
  private readonly diagLogger = diag.createComponentLogger({
    namespace: "@braintrust/otel",
  });
  private exporter?: OTLPTraceExporter;
  private exporterPromise?: Promise<OTLPTraceExporter>;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly apiUrl: string,
    private readonly parent: string,
    private readonly headers: Record<string, string> | undefined,
  ) {}

  async initialize(): Promise<void> {
    await this.getExporter();
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    void this.getExporter()
      .then((exporter) => {
        const compatibleSpans = spans.map((span) => {
          const spanWithCompatFields = span as ReadableSpan & {
            instrumentationLibrary?: unknown;
            instrumentationScope?: unknown;
            parentSpanContext?: { spanId?: string; isRemote?: boolean };
            parentSpanId?: string;
          };
          const instrumentationScope =
            spanWithCompatFields.instrumentationScope ??
            spanWithCompatFields.instrumentationLibrary;
          const instrumentationLibrary =
            spanWithCompatFields.instrumentationLibrary ??
            spanWithCompatFields.instrumentationScope;
          const parentSpanContext =
            spanWithCompatFields.parentSpanContext ??
            (spanWithCompatFields.parentSpanId
              ? {
                  ...span.spanContext(),
                  spanId: spanWithCompatFields.parentSpanId,
                  isRemote: false,
                }
              : undefined);
          const parentSpanId =
            spanWithCompatFields.parentSpanId ??
            spanWithCompatFields.parentSpanContext?.spanId;

          return new Proxy(span, {
            get(target, prop) {
              if (prop === "instrumentationScope") {
                return instrumentationScope;
              }
              if (prop === "instrumentationLibrary") {
                return instrumentationLibrary;
              }
              if (prop === "parentSpanContext") {
                return parentSpanContext;
              }
              if (prop === "parentSpanId") {
                return parentSpanId;
              }

              const value = Reflect.get(target, prop, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
            has(target, prop) {
              return (
                prop === "instrumentationScope" ||
                prop === "instrumentationLibrary" ||
                prop === "parentSpanContext" ||
                prop === "parentSpanId" ||
                prop in target
              );
            },
          });
        });

        exporter.export(compatibleSpans, (result) => {
          if (result.code !== 0) {
            this.diagLogger.error(
              "Braintrust OTLP span export failed",
              result.error,
            );
          }
          resultCallback(result);
        });
      })
      .catch((error) => {
        const errorObj =
          error instanceof Error ? error : new Error(String(error));
        this.diagLogger.error("Braintrust OTLP span export failed", errorObj);
        resultCallback({ code: 1, error: errorObj });
      });
  }

  shutdown(): Promise<void> {
    if (!this.exporterPromise) {
      return Promise.resolve();
    }
    return this.getExporter().then((exporter) => exporter.shutdown());
  }

  private getExporter(): Promise<OTLPTraceExporter> {
    if (!this.exporterPromise) {
      this.exporterPromise = (async () => {
        const apiKey =
          this.apiKey !== undefined
            ? this.apiKey
            : getEnv("BRAINTRUST_API_KEY");
        if (!apiKey?.trim()) {
          throw new Error(
            "Braintrust API key is required. Set BRAINTRUST_API_KEY, define it in .env.braintrust, or pass apiKey option.",
          );
        }

        this.exporter = new OTLPTraceExporter({
          url: new URL("otel/v1/traces", this.apiUrl).href,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "x-bt-parent": this.parent,
            ...this.headers,
          },
        });
        return this.exporter;
      })();
    }
    return this.exporterPromise;
  }
}

/**
 * A span processor that sends OpenTelemetry spans to Braintrust.
 *
 * This processor uses a BatchSpanProcessor and an OTLP exporter configured
 * to send data to Braintrust's telemetry endpoint. Span filtering is disabled
 * by default but can be enabled with the filterAISpans option.
 *
 * Environment Variables:
 * - BRAINTRUST_API_KEY: Your Braintrust API key. In Node.js, this can also be set in the nearest .env.braintrust file.
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
  private readonly exporter?: LazyBraintrustOTLPTraceExporter;
  private readonly environment?: { type?: string; name?: string };

  constructor(options: BraintrustSpanProcessorOptions = {}) {
    this.environment = detectEnvironment(options.environment);
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
    const apiKey =
      options.apiKey !== undefined
        ? options.apiKey
        : getEnv("BRAINTRUST_API_KEY");

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

    const exporter = new LazyBraintrustOTLPTraceExporter(
      apiKey,
      apiUrl,
      parent,
      options.headers,
    );
    this.exporter = exporter;

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
    this.aiSpanProcessor.onEnd(
      withSpanOriginAttributes(span, this.environment),
    );
  }

  shutdown(): Promise<void> {
    return this.aiSpanProcessor.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.exporter?.initialize();
    return this.aiSpanProcessor.forceFlush();
  }
}

/** Create an OTEL context from a Braintrust span using W3C propagation. */
export function contextFromSpan(span: BraintrustSpan): Context {
  return braintrustW3CPropagator.extract(
    context.active(),
    span.inject(),
    traceContextGetter,
  );
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
  try {
    if (typeof span.inject !== "function") return undefined;
    const baggage = span.inject().baggage;
    for (const member of baggage?.split(",") ?? []) {
      const [rawKey, rawValue] = member.trim().split("=", 2);
      if (rawKey === "braintrust.parent" && rawValue) {
        return decodeURIComponent(rawValue.split(";", 1)[0]);
      }
    }
  } catch (e) {
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
 * - BRAINTRUST_API_KEY: Your Braintrust API key. In Node.js, this can also be set in the nearest .env.braintrust file.
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

/** Extract an opaque Braintrust parent context from W3C headers. */
export function parentFromHeaders(
  headers: Record<string, string>,
): PropagationContext | undefined {
  return extractTraceContextFromHeaders(headers);
}
