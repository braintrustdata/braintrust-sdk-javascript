import { registerOtelFlush } from "braintrust/instrumentation";
import { customizeOtelSpans, isCustomizedOtelSpan } from "./span-customizer";

import {
  context,
  Context,
  trace,
  propagation,
  Span,
  createTraceState,
} from "@opentelemetry/api";
import type {
  SpanProcessor,
  ReadableSpan,
  SpanExporter,
  ExportResult,
} from "./types";
import {
  currentSpan,
  extractTraceContextFromHeaders,
  type PropagationContext,
  type Span as BraintrustSpan,
} from "braintrust";

declare const __BRAINTRUST_OTEL_VERSION__: string;

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

/**
 * Custom filter function type for span filtering.
 * @param span - The span to evaluate
 * @returns true to definitely keep, false to definitely drop, null/undefined to not influence the decision
 */
type CustomSpanFilter<S extends ReadableSpan = ReadableSpan> = (
  span: S,
) => boolean | null | undefined;

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
  return !span.parentSpanId && !span.parentSpanContext;
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

interface BraintrustOtlpOptions {
  /** Defaults to BRAINTRUST_API_KEY or the nearest .env.braintrust file. */
  apiKey?: string;
  /** Defaults to BRAINTRUST_API_URL or https://api.braintrust.dev. */
  apiUrl?: string;
  /** Required project or experiment routing, or BRAINTRUST_PARENT. */
  parent?: string;
  headers?: Record<string, string>;
}

interface SpanOptions<S extends ReadableSpan> {
  filterAISpans?: boolean;
  customFilter?: CustomSpanFilter<S>;
  environment?: { type?: string; name?: string };
}

/** Configure the application's OTLP/HTTP exporter without selecting an SDK. */
export function braintrustOtlpConfig(options: BraintrustOtlpOptions = {}): {
  url: string;
  headers: Record<string, string>;
} {
  const apiKey = options.apiKey ?? getEnv("BRAINTRUST_API_KEY");
  if (!apiKey?.trim()) {
    throw new Error(
      "Braintrust API key is required. Set BRAINTRUST_API_KEY, define it in .env.braintrust, or pass apiKey.",
    );
  }
  const parent = options.parent ?? getEnv("BRAINTRUST_PARENT");
  if (!parent?.trim()) {
    throw new Error(
      "Braintrust parent is required. Set BRAINTRUST_PARENT or pass parent.",
    );
  }
  const apiUrl =
    options.apiUrl ??
    getEnv("BRAINTRUST_API_URL") ??
    "https://api.braintrust.dev";
  return {
    url: new URL("otel/v1/traces", apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`)
      .href,
    headers: {
      ...Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(
          ([name]) =>
            !["authorization", "x-bt-parent"].includes(name.toLowerCase()),
        ),
      ),
      Authorization: `Bearer ${apiKey}`,
      "x-bt-parent": parent,
    },
  };
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

function withSpanOriginAttributes<S extends ReadableSpan>(
  span: S,
  environment?: { type?: string; name?: string },
): S {
  if (isCustomizedOtelSpan(span)) return span;
  const attributes = {
    ...span.attributes,
    "braintrust.context_json": mergeSpanOriginContextJson(
      span.attributes["braintrust.context_json"],
      environment,
    ),
  };
  return new Proxy(span, {
    get(target, prop) {
      if (prop === "attributes") return attributes;
      const value = Reflect.get(target, prop, target);
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

/**
 * Enrich and filter spans before forwarding to an application-owned processor.
 * Batching, sampling, export timeouts and transport remain owned by that SDK.
 * Use BraintrustExporter around the transport to apply export customizers.
 */
export class BraintrustSpanProcessor<S extends ReadableSpan = ReadableSpan> {
  private readonly processor: SpanProcessor<S>;
  private readonly environment?: { type?: string; name?: string };
  private readonly unregisterFlush: () => void;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly options: SpanOptions<S> & { processor: SpanProcessor<S> },
  ) {
    this.processor = options.processor;
    this.environment = detectEnvironment(options.environment);
    this.unregisterFlush = registerOtelFlush(() => this.forceFlush());
  }

  onStart(span: Span, parentContext: Context): void {
    const baggageParent = propagation
      .getBaggage(parentContext)
      ?.getEntry("braintrust.parent")?.value;
    const parentSpan = trace.getSpan(parentContext);
    const inherited =
      parentSpan && "attributes" in parentSpan
        ? (parentSpan.attributes as ReadableSpan["attributes"])[
            "braintrust.parent"
          ]
        : undefined;
    const parent =
      baggageParent ??
      (typeof inherited === "string" ? inherited : undefined) ??
      (parentContext === context.active()
        ? getOtelParentFromSpan(currentSpan())
        : undefined);
    if (parent) span.setAttribute("braintrust.parent", parent);
    this.processor.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this.processor.onEnding?.(span);
  }

  onEnd(span: S): void {
    const enriched = withSpanOriginAttributes(span, this.environment);
    if (
      this.options.filterAISpans &&
      !(this.options.customFilter?.(enriched) ?? isAISpan(enriched))
    )
      return;
    this.processor.onEnd(enriched);
  }

  forceFlush(): Promise<void> {
    return this.processor.forceFlush();
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.unregisterFlush();
      this.shutdownPromise = this.processor.shutdown();
    }
    return this.shutdownPromise;
  }
}

/**
 * Customize and forward completed batches to an application-owned exporter.
 * This exporter never creates a processor, queue or timer.
 */
export class BraintrustExporter<S extends ReadableSpan = ReadableSpan> {
  private readonly environment?: { type?: string; name?: string };
  private readonly pending = new Set<Promise<void>>();
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly options: SpanOptions<S> & { exporter: SpanExporter<S> },
  ) {
    this.environment = detectEnvironment(options.environment);
  }

  export(spans: S[], callback: (result: ExportResult) => void): void {
    if (this.shutdownPromise) {
      callback({
        code: 1,
        error: new Error("BraintrustExporter is shut down"),
      });
      return;
    }
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.pending.add(pending);
    let finished = false;
    const finish = (result: ExportResult) => {
      if (finished) return;
      finished = true;
      this.pending.delete(pending);
      complete();
      callback(result);
    };
    void (async () => {
      const filtered = this.options.filterAISpans
        ? spans.filter(
            (span) => this.options.customFilter?.(span) ?? isAISpan(span),
          )
        : spans;
      const prepared = await customizeOtelSpans(
        filtered.map((span) =>
          withSpanOriginAttributes(span, this.environment),
        ),
      );
      if (prepared.length === 0) {
        finish({ code: 0 });
        return;
      }
      this.options.exporter.export(prepared, finish);
    })().catch((error: unknown) => {
      finish({
        code: 1,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.pending);
    await this.options.exporter.forceFlush?.();
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      await Promise.all(this.pending);
      await this.options.exporter.shutdown();
    })();
    return this.shutdownPromise;
  }
}

/** Create an OTEL context from a Braintrust span using W3C propagation. */
export function contextFromSpan(span: BraintrustSpan): Context {
  const headers = extractTraceContextFromHeaders(span.inject());
  if (!headers) return context.active();
  // The native SDK has already validated the W3C header.
  const [, traceId, spanId, flags] = headers.traceparent.split("-");
  let ctx = trace.setSpanContext(context.active(), {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
    ...(headers.tracestate
      ? { traceState: createTraceState(headers.tracestate) }
      : {}),
  });
  const parent = getOtelParentFromSpan(span);
  if (parent) ctx = addParentToBaggage(parent, ctx);
  return ctx;
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
 * const ctx = addParentToBaggage("project_name:my-project");
 *
 * // Export headers (will include braintrust.parent in baggage)
 * const headers = {};
 * propagation.inject(ctx, headers);
 * ```
 */
export function addParentToBaggage(parent: string, ctx?: Context): Context {
  const currentCtx = ctx ?? context.active();
  const baggage =
    propagation.getBaggage(currentCtx) ?? propagation.createBaggage();
  return propagation.setBaggage(
    currentCtx,
    baggage.setEntry("braintrust.parent", { value: parent }),
  );
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
 * import { addSpanParentToBaggage } from "@braintrust/otel";
 * import { propagation } from "@opentelemetry/api";
 *
 * tracer.startActiveSpan("service_b", (span) => {
 *   // Copy braintrust.parent from span attribute to baggage
 *   const ctx = addSpanParentToBaggage(span);
 *
 *   // Export headers (will include braintrust.parent in baggage)
 *   const headers = {};
 *   if (ctx) propagation.inject(ctx, headers);
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
