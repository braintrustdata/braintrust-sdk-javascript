import { createTraceState, type SpanContext } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

type RecordData = Record<string, unknown>;
const CUSTOMIZED = Symbol.for("braintrust.customizedOtelSpan");
const RUNTIME_KEY = Symbol.for("braintrust.spanCustomizerRuntime");
const FAILURE_LOGGED_KEY = Symbol.for("braintrust.spanCustomizerFailureLogged");

interface SpanExportAdapter {
  snapshot(data: RecordData): RecordData;
  restore(data: RecordData): RecordData;
  strip(data: RecordData): RecordData;
}

interface SpanCustomizerRuntime {
  isPlainRecord(value: unknown): boolean;
  hasCustomizers(): boolean;
  customize(data: RecordData, adapter: SpanExportAdapter): RecordData;
}

// braintrust registers its shared customizer policy under a global symbol.
// Versions without span customizers never register it, so spans pass through.
function runtime(): SpanCustomizerRuntime | undefined {
  return (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] as
    | SpanCustomizerRuntime
    | undefined;
}

type ResourceCache = Map<object, RecordData[]>;

interface OtelCompatFields {
  instrumentationScope?: unknown;
  instrumentationLibrary?: unknown;
  parentSpanContext?: SpanContext;
  parentSpanId?: string;
}

/** Normalize fields renamed between OTel 1.x and 2.x so either serializer works. */
export function otelCompatFields(span: ReadableSpan): OtelCompatFields {
  const compatible = span as ReadableSpan & OtelCompatFields;
  return {
    instrumentationScope:
      compatible.instrumentationScope ?? compatible.instrumentationLibrary,
    instrumentationLibrary:
      compatible.instrumentationLibrary ?? compatible.instrumentationScope,
    parentSpanContext:
      compatible.parentSpanContext ??
      (compatible.parentSpanId
        ? {
            ...span.spanContext(),
            spanId: compatible.parentSpanId,
            isRemote: false,
          }
        : undefined),
    parentSpanId:
      compatible.parentSpanId ?? compatible.parentSpanContext?.spanId,
  };
}

/**
 * Customize one export batch. Runs at the Braintrust exporter boundary, so
 * filtering, enrichment and sampling have already happened upstream.
 */
export async function customizeOtelSpans(
  spans: ReadableSpan[],
): Promise<ReadableSpan[]> {
  if (!runtime()?.hasCustomizers()) return spans;
  // OTLP serializers wait for async resource detectors. Snapshot only once
  // those attributes exist, so hooks can redact them too. A failed detector
  // still exports the attributes that resolved, like OTel's batch processor.
  // The calling span processor bounds this wait with its export timeout.
  const pendingResources = new Set<ReadableSpan["resource"]>();
  const pendingAttributes: Promise<void>[] = [];
  for (const { resource } of spans) {
    if (
      resource?.asyncAttributesPending &&
      resource.waitForAsyncAttributes &&
      !pendingResources.has(resource)
    ) {
      pendingResources.add(resource);
      pendingAttributes.push(resource.waitForAsyncAttributes().catch(() => {}));
    }
  }
  await Promise.all(pendingAttributes);
  // OTLP groups spans by resource object identity, so spans sharing a Resource
  // must also share equal adapted resources to keep one ResourceSpans entry.
  const resources: ResourceCache = new Map();
  return spans.flatMap((span) => {
    try {
      return [customizeOtelSpan(span, resources)];
    } catch {
      // Malformed spans fail before the strip fallback can run. Fail closed.
      reportUnexportableSpan();
      return [];
    }
  });
}

function reportUnexportableSpan(): void {
  const shared = globalThis as Record<symbol, unknown>;
  if (shared[FAILURE_LOGGED_KEY]) return;
  shared[FAILURE_LOGGED_KEY] = true;
  // Never log the exception or span: either can contain sensitive data.
  // eslint-disable-next-line no-restricted-properties -- intentional always-visible export failure.
  console.error(
    "[braintrust] Span export customizer failed; dropping an OpenTelemetry span.",
  );
}

function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = a as RecordData;
  const right = b as RecordData;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameData(left[key], right[key]),
    )
  );
}

// Copy only serialization data: no live SDK objects, getters, functions or cycles
// survive the boundary. This also validates values ignored by OTLP serializers.
// OTel accepts any number as an attribute value, including NaN and Infinity.
function copyData(
  value: unknown,
  isPlainRecord: (value: unknown) => boolean,
  ancestors = new Set<object>(),
): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (typeof value !== "object" || ancestors.has(value))
    throw new TypeError("Invalid OTel export data");
  if (!Array.isArray(value) && !isPlainRecord(value))
    throw new TypeError("Invalid OTel export container");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => copyData(item, isPlainRecord, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        copyData(item, isPlainRecord, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function record(value: unknown): RecordData {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid OTel export object");
  return value as RecordData;
}

function attributes(value: unknown): RecordData {
  const result = record(value ?? {});
  for (const item of Object.values(result)) {
    const values = Array.isArray(item) ? item : [item];
    if (
      !values.every(
        (v) =>
          v === null ||
          v === undefined ||
          typeof v === "string" ||
          typeof v === "boolean" ||
          typeof v === "number",
      )
    )
      throw new TypeError("Invalid OTel attribute");
  }
  return result;
}

function time(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  )
    throw new TypeError("Invalid OTel time");
}

function droppedCount(value: unknown): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || (value as number) < 0)
  )
    throw new TypeError("Invalid OTel dropped count");
}

function validateContext(value: unknown): RecordData {
  const result = record(value);
  if (
    typeof result.traceId !== "string" ||
    !/^[0-9a-f]{32}$/i.test(result.traceId) ||
    typeof result.spanId !== "string" ||
    !/^[0-9a-f]{16}$/i.test(result.spanId) ||
    !Number.isInteger(result.traceFlags) ||
    (result.traceState !== undefined &&
      typeof result.traceState !== "string") ||
    (result.isRemote !== undefined && typeof result.isRemote !== "boolean")
  )
    throw new TypeError("Invalid OTel span context");
  return result;
}

function contextData(context: SpanContext | undefined): RecordData | undefined {
  if (!context) return undefined;
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    ...(context.isRemote !== undefined ? { isRemote: context.isRemote } : {}),
    ...(context.traceState
      ? { traceState: context.traceState.serialize() }
      : {}),
  };
}

/** Customize an isolated, plain OTel snapshot, never a live ReadableSpan. */
function customizeOtelSpan(
  span: ReadableSpan,
  resources: ResourceCache,
): ReadableSpan {
  const policy = runtime();
  if (isCustomizedOtelSpan(span) || !policy) return span;
  const copy = (value: unknown) => copyData(value, policy.isPlainRecord);
  const compatible = otelCompatFields(span);
  // Protocol snapshots are kept private, not shared with any hook.
  const identity = {
    spanContext: contextData(span.spanContext()),
    parentSpanId: compatible.parentSpanId,
    parentSpanContext: contextData(compatible.parentSpanContext),
    startTime: [...span.startTime],
    endTime: [...span.endTime],
    duration: [...span.duration],
  };
  const parent = span.attributes["braintrust.parent"];
  const routing = parent === undefined ? {} : { "braintrust.parent": parent };
  // Validate after each callback so an invalid result stops the chain.
  const restore = (data: RecordData): RecordData => {
    const result = record(copy(data));
    result.spanContext = copy(identity.spanContext);
    result.parentSpanId = identity.parentSpanId;
    result.parentSpanContext = copy(identity.parentSpanContext);
    result.startTime = [...identity.startTime];
    result.endTime = [...identity.endTime];
    result.duration = [...identity.duration];
    result.attributes = { ...attributes(result.attributes), ...routing };
    if (parent === undefined)
      delete (result.attributes as RecordData)["braintrust.parent"];
    result.name ??= "";
    result.kind ??= 0;
    result.status ??= { code: 0 };
    result.events ??= [];
    result.links ??= [];
    result.resource ??= { attributes: {} };
    result.instrumentationScope ??= { name: "" };
    if (
      typeof result.name !== "string" ||
      !Number.isInteger(result.kind) ||
      (result.kind as number) < 0 ||
      (result.kind as number) > 4
    )
      throw new TypeError("Invalid OTel span");
    const status = record(result.status);
    if (
      ![0, 1, 2].includes(status.code as number) ||
      (status.message !== undefined && typeof status.message !== "string")
    )
      throw new TypeError("Invalid OTel status");
    const resource = record(result.resource);
    resource.attributes = attributes(resource.attributes);
    const scope = record(result.instrumentationScope);
    scope.name ??= "";
    if (
      typeof scope.name !== "string" ||
      (scope.version !== undefined && typeof scope.version !== "string") ||
      (scope.schemaUrl !== undefined && typeof scope.schemaUrl !== "string") ||
      (resource.schemaUrl !== undefined &&
        typeof resource.schemaUrl !== "string")
    )
      throw new TypeError("Invalid OTel metadata");
    if (scope.attributes !== undefined)
      scope.attributes = attributes(scope.attributes);
    if (!Array.isArray(result.events) || !Array.isArray(result.links))
      throw new TypeError("Invalid OTel events or links");
    for (const item of result.events) {
      const event = record(item);
      if (typeof event.name !== "string")
        throw new TypeError("Invalid OTel event");
      time(event.time);
      event.attributes = attributes(event.attributes);
      droppedCount(event.droppedAttributesCount);
    }
    for (const item of result.links) {
      const link = record(item);
      validateContext(link.context);
      link.attributes = attributes(link.attributes);
      droppedCount(link.droppedAttributesCount);
    }
    validateContext(result.spanContext);
    for (const key of [
      "droppedAttributesCount",
      "droppedEventsCount",
      "droppedLinksCount",
    ]) {
      result[key] ??= 0;
      droppedCount(result[key]);
    }
    return result;
  };
  const data = policy.customize(
    {},
    {
      snapshot() {
        return record(
          copy({
            ...identity,
            name: span.name,
            kind: span.kind,
            attributes: span.attributes,
            events: span.events,
            links: span.links.map((link) => ({
              ...link,
              context: contextData(link.context),
            })),
            status: span.status,
            resource: {
              attributes: span.resource.attributes,
              schemaUrl: (span.resource as unknown as RecordData).schemaUrl,
            },
            instrumentationScope: compatible.instrumentationScope ?? {
              name: "",
            },
            droppedAttributesCount: span.droppedAttributesCount,
            droppedEventsCount: span.droppedEventsCount,
            droppedLinksCount: span.droppedLinksCount,
          }),
        );
      },
      restore,
      strip: () =>
        restore({
          attributes: {
            "braintrust.context_json": '{"customizer_error":true}',
          },
        }),
    },
  );
  if (Object.keys(data).length === 0) return span;
  // Share resources only after all hooks finish so later hooks cannot mutate
  // resource objects already attached to another span's export snapshot.
  const adapted = resources.get(span.resource) ?? [];
  resources.set(span.resource, adapted);
  const shared = adapted.find((resource) => sameData(resource, data.resource));
  if (shared) data.resource = shared;
  else adapted.push(record(data.resource));
  // Adapt only the customized snapshot. Never proxy/fall back to the original:
  // removal of resource, scope, events, etc. must really remove that content.
  const toContext = (value: unknown): SpanContext => {
    const context = record(value);
    return {
      ...context,
      ...(typeof context.traceState === "string"
        ? { traceState: createTraceState(context.traceState) }
        : {}),
    } as unknown as SpanContext;
  };
  const exported = {
    ...data,
    spanContext: () => toContext(data.spanContext),
    parentSpanContext:
      data.parentSpanContext && toContext(data.parentSpanContext),
    instrumentationLibrary: data.instrumentationScope,
    links: (data.links as RecordData[]).map((link) => ({
      ...link,
      context: toContext(link.context),
    })),
    ended: true,
  };
  Object.defineProperty(exported, CUSTOMIZED, { value: true });
  return exported as unknown as ReadableSpan;
}

export function isCustomizedOtelSpan(span: ReadableSpan): boolean {
  return !!(span as unknown as Record<symbol, unknown>)[CUSTOMIZED];
}
