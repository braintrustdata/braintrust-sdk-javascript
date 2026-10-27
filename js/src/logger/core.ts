/// <reference lib="dom" />
import { TypedAttachmentProcessor } from "../typed-attachments";
import {
  formatLogTemplate,
  renderLogBody,
  type ApplicationLogLevel,
  type ApplicationLogOptions,
  type ApplicationLogTemplate,
} from "../logs/templates";
import {
  automaticAttachmentOriginals,
  restoreAutomaticAttachments,
} from "../automatic-attachments";
import { v4 as uuidv4 } from "uuid";
import { Queue, DEFAULT_QUEUE_SIZE } from "../queue";
import {
  debugLogger,
  type DebugLogLevel,
  type DebugLogLevelOption,
  getEnvDebugLogLevel,
  normalizeDebugLogLevelOption,
  setDebugLogStateResolver,
  setGlobalDebugLogLevel,
} from "../debug-logger";
import {
  IDGenerator,
  getIdGenerator,
  resolveUseLegacyUuidIds,
} from "../id-gen";
import {
  BAGGAGE_HEADER,
  BRAINTRUST_PARENT_KEY,
  PropagatedState,
  TRACEPARENT_HEADER,
  TraceContextCarrier,
  TraceContextHeaders,
  TRACESTATE_HEADER,
  formatTraceparent,
  getHeader,
  mergeBaggage,
  parseBaggage,
  parseTraceparent,
} from "../propagation";
import {
  _urljoin,
  AUDIT_METADATA_FIELD,
  AUDIT_SOURCE_FIELD,
  BackgroundLogEvent,
  batchItems,
  constructJsonArray,
  ExperimentEvent,
  ExperimentLogFullArgs,
  ExperimentLogPartialArgs,
  IdField,
  IS_MERGE_FIELD,
  LogFeedbackFullArgs,
  mergeDicts,
  OBJECT_DELETE_FIELD,
  OBJECT_ID_KEYS,
  SanitizedExperimentLogPartialArgs,
  SpanComponentsV3,
  SpanComponentsV4,
  SpanComponentsV4Data,
  SpanObjectTypeV3,
  spanObjectTypeV3ToString,
  SpanType,
  SpanTypeAttribute,
  TransactionId,
  VALID_SOURCES,
} from "../util";
import {
  AttachmentReference as attachmentReferenceSchema,
  AttachmentStatus as attachmentStatusSchema,
  GitMetadataSettings as gitMetadataSettingsSchema,
} from "../sdk-schemas";
import type {
  AttachmentReference,
  BraintrustAttachmentReference,
  ExternalAttachmentReference,
  AttachmentStatus,
  GitMetadataSettings,
  ObjectReference,
} from "../sdk-types";
import { waitUntil } from "@vercel/functions";
import { z, ZodError } from "zod/v3";
import {
  BraintrustStream,
  createFinalValuePassThroughStream,
  devNullWritableStream,
} from "../functions/stream";
import iso, { IsoAsyncLocalStorage } from "#braintrust-platform";
import { LRUCache } from "../lru-cache";
import {
  addAzureBlobHeaders,
  getCurrentUnixTimestamp,
  GLOBAL_PROJECT,
  isEmpty,
  LazyValue,
  SyncLazyValue,
  runCatchFinally,
} from "../util";
import { SpanCache, CachedSpan } from "../span-cache";
import {
  detectSpanOriginEnvironment,
  getSpanInstrumentationName,
  INSTRUMENTATION_NAMES,
  mergeSpanOriginContext,
  type SpanOriginEnvironment,
} from "../span-origin";
import {
  createMaskingCustomizer,
  customizeSpanExport,
  mergeCustomizedSpanRecords,
} from "../span-customizer";
import type { SpanCustomizer, SpanExportData } from "../instrumentation/config";
import type { Experiment, ExperimentSummary } from "./experiments";
const NODE_INSPECT_CUSTOM: unique symbol = Symbol.for(
  "nodejs.util.inspect.custom",
);

const TEST_API_KEY = "___TEST_API_KEY__THIS_IS_NOT_REAL___";

const BRAINTRUST_ATTACHMENT = "braintrust_attachment";

const EXTERNAL_ATTACHMENT = "external_attachment";

export const LOGS3_OVERFLOW_REFERENCE_TYPE = "logs3_overflow";

export const RESET_CONTEXT_MANAGER_STATE: unique symbol = Symbol.for(
  "braintrust.resetContextManagerState",
);

// 6 MB for the AWS lambda gateway (from our own testing).
export const DEFAULT_MAX_REQUEST_SIZE: number = 6 * 1024 * 1024;

// Manual type definition for inline attachments (not in generated_types)
export const InlineAttachmentReferenceSchema: z.ZodType<{
  type: "inline_attachment";
  src: string;
  content_type?: string;
  filename?: string;
}> = z.object({
  type: z.literal("inline_attachment"),
  src: z.string().min(1),
  content_type: z.string().optional(),
  filename: z.string().optional(),
});

// Context management interfaces
export interface ContextParentSpanIds {
  rootSpanId: string;
  spanParents: string[];
}

export class LoginInvalidOrgError extends Error {
  constructor(public message: string) {
    super(message);
  }
}

export type SetCurrentArg = { setCurrent?: boolean };

export type StartSpanEventArgs = ExperimentLogPartialArgs & Partial<IdField>;

const INITIAL_SPAN_WRITE_AS_MERGE: unique symbol = Symbol(
  "braintrust.initial-span-write-as-merge",
);

const RESUME_SPAN_WITHOUT_INITIAL_WRITE: unique symbol = Symbol(
  "braintrust.resume-span-without-initial-write",
);

const INTERNAL_SPAN_CONTEXT: unique symbol = Symbol(
  "braintrust.internal-span-context",
);

type InitialSpanWriteAsMergeArg = {
  readonly [INITIAL_SPAN_WRITE_AS_MERGE]?: true;
  readonly [RESUME_SPAN_WITHOUT_INITIAL_WRITE]?: true;
};

type InternalSpanContextArg = {
  readonly [INTERNAL_SPAN_CONTEXT]?: Record<string, unknown>;
};

export type StartSpanArgs = {
  name?: string;
  type?: SpanType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spanAttributes?: Record<any, any>;
  startTime?: number;
  /**
   * An opaque W3C trace context returned by
   * {@link extractTraceContextFromHeaders}.
   */
  parent?: PropagationContext;
  event?: StartSpanEventArgs;
  propagatedEvent?: StartSpanEventArgs;
  spanId?: string;
  parentSpanIds?: ParentSpanIds | MultiParentSpanIds;
};

type InternalStartSpanArgs = Omit<StartSpanArgs, "parent"> & {
  parent?: string | PropagationContext;
};

export type EndSpanArgs = {
  endTime?: number;
};

export interface Exportable {
  /**
   * Return a serialized representation of the object that can be used to start subspans in other places. See {@link Span.traced} for more details.
   */
  export(): Promise<string>;
}

/**
 * A Span encapsulates logged data and metrics for a unit of work. This interface is shared by all span implementations.
 *
 * We suggest using one of the various `traced` methods, instead of creating Spans directly. See {@link Span.traced} for full details.
 */
export interface Span extends Exportable {
  /**
   * Row ID of the span.
   */
  id: string;

  /**
   * Span ID of the span.
   */
  spanId: string;

  /**
   * Root span ID of the span.
   */
  rootSpanId: string;

  /**
   * Parent span IDs of the span.
   */
  spanParents: string[];

  getParentInfo():
    | {
        objectType: SpanObjectTypeV3;
        objectId: LazyValue<string>;
        computeObjectMetadataArgs: Record<string, unknown> | undefined;
      }
    | undefined;

  /**
   * Incrementally update the current span with new data. The event will be batched and uploaded behind the scenes.
   *
   * @param event: Data to be logged. See {@link Experiment.log} for full details.
   */
  log(event: ExperimentLogPartialArgs): void;

  /**
   * Add feedback to the current span. Unlike `Experiment.logFeedback` and `Logger.logFeedback`, this method does not accept an id parameter, because it logs feedback to the current span.
   *
   * @param event: Data to be logged. See {@link Experiment.logFeedback} for full details.
   */
  logFeedback(event: Omit<LogFeedbackFullArgs, "id">): void;

  /**
   * Create a new span and run the provided callback. This is useful if you want to log more detailed trace information beyond the scope of a single log event. Data logged over several calls to `Span.log` will be merged into one logical row.
   *
   * Spans created within `traced` are ended automatically. By default, the span is marked as current, so they can be accessed using `braintrust.currentSpan`.
   *
   * @param callback The function to be run under the span context.
   * @param args.name Optional name of the span. If not provided, a name will be inferred from the call stack.
   * @param args.type Optional type of the span. If not provided, the type will be unset.
   * @param args.span_attributes Optional additional attributes to attach to the span, such as a type name.
   * @param args.start_time Optional start time of the span, as a timestamp in seconds.
   * @param args.setCurrent If true (the default), the span will be marked as the currently-active span for the duration of the callback.
   * @param args.parent Optional parent info string for the span. The string can be generated from `[Span,Experiment,Logger].export`. If not provided, the current span will be used (depending on context). This is useful for adding spans to an existing trace.
   * @param args.event Data to be logged. See {@link Experiment.log} for full details.
   * @returns The result of running `callback`.
   */
  traced<R>(
    callback: (span: Span) => R,
    args?: StartSpanArgs & SetCurrentArg,
  ): R;

  /**
   * Lower-level alternative to `traced`. This allows you to start a span yourself, and can be useful in situations
   * where you cannot use callbacks. However, spans started with `startSpan` will not be marked as the "current span",
   * so `currentSpan()` and `traced()` will be no-ops. If you want to mark a span as current, use `traced` instead.
   *
   * See {@link Span.traced} for full details.
   *
   * @returns The newly-created `Span`
   */
  startSpan(args?: StartSpanArgs): Span;

  /**
   * Log an end time to the span (defaults to the current time). Returns the logged time.
   *
   * Will be invoked automatically if the span is constructed with `traced`.
   *
   * @param args.endTime Optional end time of the span, as a timestamp in seconds.
   * @returns The end time logged to the span metrics.
   */
  end(args?: EndSpanArgs): number;

  /**
   * Serialize the identifiers of this span. The return value can be used to
   * identify this span when starting a subspan elsewhere, such as another
   * process or service, without needing to access this `Span` object. See the
   * parameters of {@link Span.startSpan} for usage details.
   *
   * Callers should treat the return value as opaque. The serialization format
   * may change from time to time. For cross-service propagation, prefer
   * {@link Span.inject} and {@link extractTraceContextFromHeaders}.
   *
   * @returns Serialized representation of this span's identifiers.
   */
  export(): Promise<string>;

  /**
   * Inject W3C trace-context headers (`traceparent` and `baggage`) for this span
   * into a carrier, for distributed tracing across service boundaries.
   *
   * Adds `traceparent` (trace identity) and, when this span's Braintrust parent
   * is known, a `baggage` entry `braintrust.parent=<parent>` (merged with any
   * pre-existing baggage). Propagation is best-effort and never throws; if the
   * span's ids are not W3C-shaped hex (e.g. legacy UUID mode), `traceparent` is
   * omitted.
   *
   * @param carrier Optional existing carrier (e.g. outbound HTTP headers) to
   *   mutate and return. Supports plain objects, Web `Headers`, Node-style
   *   `setHeader` carriers, framework `header` carriers, and mutable
   *   `HeadersInit` tuple arrays. A new object is created if not provided.
   * @returns The carrier with propagation headers injected.
   */
  inject(): Record<string, string>;
  inject<T extends TraceContextCarrier>(carrier: T): T;

  /**
   * Format a permalink to the Braintrust application for viewing this span.
   *
   * Links can be generated at any time, but they will only become viewable
   * after the span and its root have been flushed to the server and ingested.
   *
   * This function can block resolving data with the server. For production
   * applications it's preferable to call {@link Span.link} instead.
   *
   * @returns A promise which resolves to a permalink to the span.
   */
  permalink(): Promise<string>;

  /**
   * Format a link to the Braintrust application for viewing this span.
   *
   * Links can be generated at any time, but they will only become viewable
   * after the span and its root have been flushed to the server and ingested.
   *
   * There are some conditions when a Span doesn't have enough information
   * to return a stable link (e.g. during an unresolved experiment). In this case
   * or if there's an error generating link, we'll return a placeholder link.
   *
   * @returns A link to the span.
   */
  link(): string;

  /**
   * Flush any pending rows to the server.
   */
  flush(): Promise<void>;

  /**
   * Set the span's name, type, or other attributes after it's created.
   */
  setAttributes(args: Omit<StartSpanArgs, "event">): void;

  /**
   * Start a span with a specific id and parent span ids.
   */
  startSpanWithParents(
    spanId: string,
    spanParents: string[],
    args?: StartSpanArgs,
  ): Span;

  /*
   * Gets the span's `state` value, which is usually the global logging state (this is
   * for very advanced purposes only)
   */
  state(): BraintrustState;

  // For type identification.
  kind: "span";
}

/**
 * The AsyncLocalStorage contract used by context-manager integrations.
 *
 * The stored value is intentionally opaque (`unknown`) because the concrete type
 * depends on the active context manager:
 * - Default (`BraintrustContextManager`): stores a `Span`
 * - OTEL compat (`OtelContextManager`): stores an OTEL `Context` object
 *
 * The global hook's `bindStore` transform (via `wrapSpanForStore`) produces the
 * correct value type for whichever mode is active.
 */
export type CurrentSpanStore = IsoAsyncLocalStorage<unknown>;

export abstract class ContextManager {
  abstract getParentSpanIds(): ContextParentSpanIds | undefined;
  abstract runInContext<R>(span: Span, callback: () => R): R;
  abstract getCurrentSpan(): Span | undefined;

  /**
   * Return the store used by instrumentation hooks to propagate the current
   * span, when the context manager supports direct store binding.
   */
  getCurrentSpanStore(): CurrentSpanStore | undefined {
    return undefined;
  }

  /**
   * Returns the value to store in the ALS bound to a global hook's start event.
   * In default mode this is the Span itself; in OTEL mode it is the OTEL Context
   * containing the span so that OTEL's own ALS stores a proper Context object.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapSpanForStore(span: Span): unknown {
    return span;
  }
}

class BraintrustContextManager extends ContextManager {
  private _currentSpan: IsoAsyncLocalStorage<Span>;

  constructor() {
    super();
    this._currentSpan = iso.newAsyncLocalStorage();
  }

  getCurrentSpanStore(): CurrentSpanStore {
    return this._currentSpan;
  }

  getParentSpanIds(): ContextParentSpanIds | undefined {
    const currentSpan = this._currentSpan.getStore();
    if (!currentSpan) {
      return undefined;
    }

    return {
      rootSpanId: currentSpan.rootSpanId,
      spanParents: [currentSpan.spanId],
    };
  }

  runInContext<R>(span: Span, callback: () => R): R {
    return this._currentSpan.run(span, callback);
  }

  getCurrentSpan(): Span | undefined {
    return this._currentSpan.getStore();
  }
}

declare global {
  var BRAINTRUST_CONTEXT_MANAGER: (new () => ContextManager) | undefined;
}

type SpanComponent = typeof SpanComponentsV3 | typeof SpanComponentsV4;

// Return the active span-component exporter class.
//
// The export version is coupled to the active ID format: hex IDs (the default)
// serialize as V4, legacy UUID IDs serialize as V3. These must move together --
// serializing hex IDs via V3 would lose the compact encoding and risk
// corrupting hex values that happen to parse as UUIDs. An explicit
export function getSpanComponentsClass(): SpanComponent {
  return resolveUseLegacyUuidIds() ? SpanComponentsV3 : SpanComponentsV4;
}

export function getContextManager(): ContextManager {
  return globalThis.BRAINTRUST_CONTEXT_MANAGER
    ? new globalThis.BRAINTRUST_CONTEXT_MANAGER()
    : new BraintrustContextManager();
}

/**
 * Configure the context manager used by Braintrust.
 *
 * This extension point is intended for runtime integrations such as
 * `@braintrust/otel` and `@braintrust/browser`. Passing `undefined` restores
 * Braintrust's default context manager.
 */
export function configureContextManager(
  contextManager: (new () => ContextManager) | undefined,
): void {
  globalThis.BRAINTRUST_CONTEXT_MANAGER = contextManager;
  _globalState?.[RESET_CONTEXT_MANAGER_STATE]();
}

/**
 * A fake implementation of the Span API which does nothing. This can be used as the default span.
 */
export class NoopSpan implements Span {
  public id: string;
  public spanId: string;
  public rootSpanId: string;
  public spanParents: string[];

  public kind: "span" = "span" as const;

  constructor() {
    this.id = "";
    this.spanId = "";
    this.rootSpanId = "";
    this.spanParents = [];
  }

  public log(_: ExperimentLogPartialArgs): void {}

  public logFeedback(_event: Omit<LogFeedbackFullArgs, "id">): void {}

  public traced<R>(
    callback: (span: Span) => R,
    _1?: StartSpanArgs & SetCurrentArg,
  ): R {
    return callback(this);
  }

  public getParentInfo() {
    return undefined;
  }

  public startSpan(_1?: StartSpanArgs): this {
    return this;
  }

  public end(args?: EndSpanArgs): number {
    return args?.endTime ?? getCurrentUnixTimestamp();
  }

  public async export(): Promise<string> {
    return "";
  }

  public inject(): Record<string, string>;
  public inject<T extends TraceContextCarrier>(carrier: T): T;
  public inject<T extends TraceContextCarrier>(
    carrier?: T,
  ): T | Record<string, string> {
    return carrier ?? {};
  }

  public async permalink(): Promise<string> {
    return NOOP_SPAN_PERMALINK;
  }

  public link(): string {
    return NOOP_SPAN_PERMALINK;
  }

  public async flush(): Promise<void> {}

  public setAttributes(_args: Omit<StartSpanArgs, "event">): void {}

  public startSpanWithParents(
    _spanId: string,
    _spanParents: string[],
    _args?: StartSpanArgs,
  ): Span {
    return this;
  }

  public state(): BraintrustState {
    return _internalGetGlobalState();
  }

  // Custom inspect for Node.js console.log
  static {
    Object.defineProperty(this.prototype, NODE_INSPECT_CUSTOM, {
      configurable: true,
      writable: true,
      value(this: NoopSpan): string {
        return `NoopSpan {
  kind: '${this.kind}',
  id: '${this.id}',
  spanId: '${this.spanId}',
  rootSpanId: '${this.rootSpanId}',
  spanParents: ${JSON.stringify(this.spanParents)}
}`;
      },
    });
  }

  // Custom toString
  toString(): string {
    return `NoopSpan(id=${this.id}, spanId=${this.spanId})`;
  }
}

export const NOOP_SPAN: NoopSpan = new NoopSpan();

export const NOOP_SPAN_PERMALINK = "https://braintrust.dev/noop-span";

// In certain situations (e.g. the cli), we want separately-compiled modules to
// use the same state as the toplevel module. Use a symbol on `globalThis.
declare global {
  interface Global {
    [key: symbol]: any;
  }
}

const loginSchema = z.strictObject({
  appUrl: z.string(),
  appPublicUrl: z.string(),
  orgName: z.string(),
  apiUrl: z.string(),
  proxyUrl: z.string(),
  loginToken: z.string(),
  orgId: z.string().nullish(),
  gitMetadataSettings: gitMetadataSettingsSchema.nullish(),
  debugLogLevel: z.enum(["error", "warn", "info", "debug"]).optional(),
  // Distinguishes explicit false from unset so env fallback stays disabled after deserialization.
  debugLogLevelDisabled: z.boolean().optional(),
});

export type SerializedBraintrustState = {
  appUrl: string;
  appPublicUrl: string;
  orgName: string;
  apiUrl: string;
  proxyUrl: string;
  loginToken: string;
  orgId?: string | null;
  gitMetadataSettings?: GitMetadataSettings | null;
  debugLogLevel?: "error" | "warn" | "info" | "debug";
  debugLogLevelDisabled?: boolean;
};

let stateNonce = 0;

const V1_PROXY_SUFFIX = "/v1/proxy";

const LOADER_LOGIN_CACHE_MAX = 16;

const LOGIN_TIMEOUT_MS = 30_000;

const PROJECT_LOOKUP_TIMEOUT_MS = 30_000;

const PROJECT_CACHE_TTL_MS = 15 * 60 * 1000;

export type ResolvedLoaderLoginOptions = Required<
  Pick<LoginOptions, "apiKey" | "appUrl" | "fetch">
> &
  Pick<LoginOptions, "orgName"> & {
    forceLogin?: boolean;
    credentialCacheNamespace: string;
    existingState?: BraintrustState;
  };

export type LoaderRequestState = Pick<
  BraintrustState,
  "appUrl" | "orgId" | "apiConn"
>;

// proxyUrl may point at the universal proxy (`{apiUrl}/v1/proxy`) for
// EU/self-hosted orgs, but proxyConn only targets Braintrust API endpoints
// (e.g. function/invoke, function/sandbox-list) served at the API host root.
// Drop the suffix so these requests resolve on all data planes.
function normalizeProxyConnUrl(proxyUrl: string): string {
  return proxyUrl.endsWith(V1_PROXY_SUFFIX)
    ? proxyUrl.slice(0, proxyUrl.length - V1_PROXY_SUFFIX.length)
    : proxyUrl;
}

/** @internal */
export const CAPTURE_ATTACHMENTS: unique symbol = Symbol.for(
  "braintrust.captureAttachments",
);

function autoCaptureAttachmentsFromEnv(): boolean {
  return ["1", "true"].includes(
    iso.getEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS")?.trim().toLowerCase() ??
      "",
  );
}

/**
 * @internal Resolve automatic attachment capture for a logger or span. Only plain
 * fields are read, so parents and global state from other SDK bundles also work.
 */
export function _internalCaptureAttachmentsEnabled(parent?: object): boolean {
  // Global state is unset until a platform entrypoint configures the SDK.
  const owner = parent ?? (_globalState ? getSpanParentObject() : undefined);
  const policy = owner && Reflect.get(owner, CAPTURE_ATTACHMENTS);
  return typeof policy === "boolean"
    ? policy
    : (_globalState?.autoCaptureAttachments ?? autoCaptureAttachmentsFromEnv());
}

export class BraintrustState {
  public id: string;
  public currentExperiment: Experiment | undefined;
  public currentLogger: Logger | undefined;
  public currentParent: IsoAsyncLocalStorage<string | PropagationContext>;
  public currentSpan: IsoAsyncLocalStorage<Span>;
  // Any time we re-log in, we directly update the apiConn inside the logger.
  // This is preferable to replacing the whole logger, which would create the
  // possibility of multiple loggers floating around, which may not log in a
  // deterministic order.
  private _bgLogger: SyncLazyValue<HTTPBackgroundLogger>;
  private _overrideBgLogger: BackgroundLogger | null = null;

  public appUrl: string | null = null;
  public appPublicUrl: string | null = null;
  public loginToken: string | null = null;
  public orgId: string | null = null;
  public orgName: string | null = null;
  public apiUrl: string | null = null;
  public proxyUrl: string | null = null;
  public loggedIn: boolean = false;
  public gitMetadataSettings?: GitMetadataSettings;
  /** @internal Default for instrumentation without a logger-specific policy. */
  public autoCaptureAttachments?: boolean;
  public debugLogLevel?: DebugLogLevel;
  private debugLogLevelConfigured = false;

  public fetch: typeof globalThis.fetch = globalThis.fetch;
  private _appConn: HTTPConnection | null = null;
  private _apiConn: HTTPConnection | null = null;
  private _proxyConn: HTTPConnection | null = null;
  private _spanCache: SpanCache | undefined;

  public get spanCache(): SpanCache {
    return (this._spanCache ??= new SpanCache({
      disabled: this.loginParams.disableSpanCache,
    }));
  }

  public set spanCache(cache: SpanCache) {
    this._spanCache = cache;
  }
  /** @internal */
  public readonly projectMetadataCache: LRUCache<
    string,
    { promise: Promise<OrgProjectMetadata>; expiresAt: number }
  > = new LRUCache<
    string,
    { promise: Promise<OrgProjectMetadata>; expiresAt: number }
  >({ max: 1000 });
  private _idGenerator: IDGenerator | null = null;
  private _contextManager: ContextManager | null = null;
  private _otelFlushCallback: (() => Promise<void>) | null = null;
  public spanOriginEnvironment: SpanOriginEnvironment | undefined;
  private traceContextSigningSecret: string | undefined;
  private loaderLoginCache = new WeakMap<
    typeof globalThis.fetch,
    LRUCache<string, Promise<LoaderRequestState>>
  >();

  private readonly loginParams: LoginOptions;
  private activeLoginOrgNameSelector: string | undefined;
  private loginGeneration = 0;
  private loginQueueTail: Promise<void> | undefined;
  private pendingLogins = new WeakMap<
    typeof globalThis.fetch,
    Map<string, Promise<void>>
  >();

  constructor(loginParams: LoginOptions) {
    this.loginParams = { ...loginParams };
    this.activeLoginOrgNameSelector =
      loginParams.orgName ?? iso.getEnv("BRAINTRUST_ORG_NAME");
    this.id = `${new Date().toLocaleString()}-${stateNonce++}`; // This is for debugging. uuidv4() breaks on platforms like Cloudflare.
    this.currentExperiment = undefined;
    this.currentLogger = undefined;
    this.currentParent = iso.newAsyncLocalStorage<
      string | PropagationContext
    >();
    this.currentSpan = iso.newAsyncLocalStorage();

    if (loginParams.fetch) {
      this.fetch = loginParams.fetch;
    }

    const defaultGetLogConn = async () => {
      await this.login({});
      return this.apiConn();
    };
    this._bgLogger = new SyncLazyValue(
      () =>
        new HTTPBackgroundLogger(new LazyValue(defaultGetLogConn), loginParams),
    );

    if (loginParams.debugLogLevel !== undefined) {
      this.debugLogLevelConfigured = true;
      this.debugLogLevel = normalizeDebugLogLevelOption(
        loginParams.debugLogLevel,
      );
      setGlobalDebugLogLevel(this.debugLogLevel ?? false);
    } else {
      this.debugLogLevel = getEnvDebugLogLevel();
      setGlobalDebugLogLevel(undefined);
    }

    this.resetLoginInfo();

    this.spanOriginEnvironment = detectSpanOriginEnvironment();
    this._internalSetTraceContextSigningSecret(loginParams.apiKey);
  }

  /** @internal */
  public _internalSetTraceContextSigningSecret(
    secret: string | undefined,
  ): void {
    const normalizedSecret = secret?.trim();
    if (normalizedSecret) {
      this.traceContextSigningSecret = normalizedSecret;
    }
  }

  /** @internal */
  public _internalGetTraceContextSigningSecret(): string | undefined {
    return (
      this.traceContextSigningSecret ??
      this.loginToken ??
      iso.getEnv("BRAINTRUST_API_KEY")
    )?.trim();
  }

  public resetLoginInfo(): void {
    this.loginGeneration++;
    this.loginQueueTail = undefined;
    this.pendingLogins = new WeakMap();
    this.projectMetadataCache.clear();
    this.appUrl = null;
    this.appPublicUrl = null;
    this.loginToken = null;
    this.orgId = null;
    this.orgName = null;
    this.apiUrl = null;
    this.proxyUrl = null;
    this.loggedIn = false;
    this.gitMetadataSettings = undefined;

    this._appConn = null;
    this._apiConn = null;
    this._proxyConn = null;
    this.loaderLoginCache = new WeakMap();
  }

  /** @internal */
  public async _internalResolveLoaderLoginOptions({
    apiKey,
    appUrl,
    orgName,
    fetch,
    forceLogin,
  }: Pick<LoginOptions, "apiKey" | "appUrl" | "orgName" | "fetch"> & {
    forceLogin?: boolean;
  }): Promise<ResolvedLoaderLoginOptions> {
    const resolvedAppUrl =
      appUrl ??
      (this.loggedIn ? this.appUrl : undefined) ??
      this.loginParams.appUrl ??
      iso.getEnv("BRAINTRUST_APP_URL") ??
      "https://www.braintrust.dev";
    const resolvedApiKey =
      apiKey ??
      (this.loggedIn ? this.loginToken : undefined) ??
      this.loginParams.apiKey ??
      (await iso.getBraintrustApiKey());
    if (!resolvedApiKey) {
      throw new Error(
        "Please specify an api key (e.g. by setting BRAINTRUST_API_KEY).",
      );
    }
    const normalizedApiKey = HTTPConnection.sanitize_token(resolvedApiKey);
    const usesActiveCredential =
      this.loggedIn && normalizedApiKey === this.loginToken;
    const requestedOrgName =
      orgName ??
      (usesActiveCredential ? this.activeLoginOrgNameSelector : undefined) ??
      this.loginParams.orgName ??
      iso.getEnv("BRAINTRUST_ORG_NAME");
    const resolvedOrgName =
      orgName ??
      (usesActiveCredential ? this.orgName : undefined) ??
      requestedOrgName;
    const resolvedFetch =
      fetch ??
      (this.loggedIn ? this.fetch : undefined) ??
      this.loginParams.fetch ??
      globalThis.fetch;
    const credentialCacheNamespace = JSON.stringify([
      "loader-credential",
      resolvedAppUrl,
      requestedOrgName,
      normalizedApiKey,
    ]);

    return {
      apiKey: normalizedApiKey,
      appUrl: resolvedAppUrl,
      orgName: resolvedOrgName,
      fetch: resolvedFetch,
      forceLogin,
      credentialCacheNamespace,
      existingState:
        !forceLogin &&
        usesActiveCredential &&
        resolvedAppUrl === this.appUrl &&
        resolvedOrgName === this.orgName &&
        resolvedFetch === this.fetch
          ? this
          : undefined,
    };
  }

  /** @internal */
  public async _internalGetLoaderState({
    apiKey,
    appUrl,
    orgName,
    fetch,
    forceLogin,
    existingState,
  }: ResolvedLoaderLoginOptions): Promise<LoaderRequestState> {
    if (existingState) {
      return existingState;
    }

    let cache = this.loaderLoginCache.get(fetch);
    if (!cache) {
      cache = new LRUCache({ max: LOADER_LOGIN_CACHE_MAX });
      this.loaderLoginCache.set(fetch, cache);
    }

    const cacheKey = JSON.stringify([appUrl, orgName, apiKey]);
    if (!forceLogin) {
      const cachedState = cache.get(cacheKey);
      if (cachedState) {
        return cachedState;
      }
    }

    const statePromise = loginToLoaderRequestState({
      orgName,
      apiKey,
      appUrl,
      fetch,
    });
    cache.set(cacheKey, statePromise);

    try {
      return await statePromise;
    } catch (error) {
      if (cache.get(cacheKey) === statePromise) {
        cache.delete(cacheKey);
      }
      throw error;
    }
  }

  public resetIdGenState(): void {
    // Reset the ID generator so it gets recreated with current environment variables
    this._idGenerator = null;
  }

  static {
    Object.defineProperty(this.prototype, RESET_CONTEXT_MANAGER_STATE, {
      configurable: true,
      writable: true,
      value(this: BraintrustState): void {
        this._contextManager = null;
      },
    });
  }

  public get idGenerator(): IDGenerator {
    if (this._idGenerator === null) {
      this._idGenerator = getIdGenerator();
    }
    return this._idGenerator;
  }

  public get contextManager(): ContextManager {
    if (this._contextManager === null) {
      this._contextManager = getContextManager();
    }
    return this._contextManager;
  }

  /**
   * Register an OTEL flush callback. This is called by @braintrust/otel
   * when it initializes a BraintrustSpanProcessor/Exporter.
   */
  public registerOtelFlush(callback: () => Promise<void>): void {
    this._otelFlushCallback = callback;
  }

  /**
   * Flush OTEL spans if a callback is registered.
   * Called during ensureSpansFlushed to ensure OTEL spans are visible in BTQL.
   */
  public async flushOtel(): Promise<void> {
    if (this._otelFlushCallback) {
      await this._otelFlushCallback();
    }
  }

  public copyLoginInfo(other: BraintrustState): void {
    this.projectMetadataCache.clear();
    this.appUrl = other.appUrl;
    this.appPublicUrl = other.appPublicUrl;
    this.loginToken = other.loginToken;
    this.orgId = other.orgId;
    this.orgName = other.orgName;
    this.apiUrl = other.apiUrl;
    this.proxyUrl = other.proxyUrl;
    this.loggedIn = other.loggedIn;
    this.gitMetadataSettings = other.gitMetadataSettings;
    this.debugLogLevel = other.debugLogLevel;
    this.debugLogLevelConfigured = other.debugLogLevelConfigured;
    this.traceContextSigningSecret = other.traceContextSigningSecret;
    this.fetch = other.fetch;
    this.activeLoginOrgNameSelector = other.activeLoginOrgNameSelector;
    setGlobalDebugLogLevel(
      this.debugLogLevelConfigured ? (this.debugLogLevel ?? false) : undefined,
    );

    this._appConn = other._appConn;
    this._apiConn = other._apiConn;
    this.loginReplaceApiConn(this.apiConn());
    this._proxyConn = other._proxyConn;
  }

  public serialize(): SerializedBraintrustState {
    if (!this.loggedIn) {
      throw new Error(
        "Cannot serialize BraintrustState without being logged in",
      );
    }

    if (
      !this.appUrl ||
      !this.appPublicUrl ||
      !this.apiUrl ||
      !this.proxyUrl ||
      !this.orgName ||
      !this.loginToken ||
      !this.loggedIn
    ) {
      throw new Error(
        "Cannot serialize BraintrustState without all login attributes",
      );
    }

    return {
      appUrl: this.appUrl,
      appPublicUrl: this.appPublicUrl,
      loginToken: this.loginToken,
      orgId: this.orgId,
      orgName: this.orgName,
      apiUrl: this.apiUrl,
      proxyUrl: this.proxyUrl,
      gitMetadataSettings: this.gitMetadataSettings,
      ...(this.debugLogLevel ? { debugLogLevel: this.debugLogLevel } : {}),
      ...(this.debugLogLevelConfigured && !this.debugLogLevel
        ? { debugLogLevelDisabled: true }
        : {}),
    };
  }

  static deserialize(
    serialized: unknown,
    opts?: LoginOptions,
  ): BraintrustState {
    const serializedParsed = loginSchema.safeParse(serialized);
    if (!serializedParsed.success) {
      throw new Error(
        `Cannot deserialize BraintrustState: ${serializedParsed.error.message}`,
      );
    }
    const state = new BraintrustState({ ...opts });
    for (const key of Object.keys(loginSchema.shape)) {
      (state as any)[key] = (serializedParsed.data as any)[key];
    }

    if (!state.loginToken) {
      throw new Error(
        "Cannot deserialize BraintrustState without a login token",
      );
    }

    state.apiConn().set_token(state.loginToken);
    state.apiConn().make_long_lived();
    state.appConn().set_token(state.loginToken);
    if (state.proxyUrl) {
      state.proxyConn().make_long_lived();
      state.proxyConn().set_token(state.loginToken);
    }

    state.loggedIn = true;
    state.debugLogLevelConfigured =
      "debugLogLevel" in serializedParsed.data ||
      !!serializedParsed.data.debugLogLevelDisabled;
    setGlobalDebugLogLevel(
      state.debugLogLevelConfigured
        ? (state.debugLogLevel ?? false)
        : undefined,
    );
    state.loginReplaceApiConn(state.apiConn());

    return state;
  }

  public setFetch(fetch: typeof globalThis.fetch): void {
    if (fetch !== this.fetch) {
      this.projectMetadataCache.clear();
    }
    this.loginParams.fetch = fetch;
    this.fetch = fetch;
    this._apiConn?.setFetch(fetch);
    this._appConn?.setFetch(fetch);
  }

  public setMaskingFunction(
    maskingFunction: ((value: unknown) => unknown) | null,
  ): void {
    this.bgLogger().setMaskingFunction(maskingFunction);
  }

  public setDebugLogLevel(option: DebugLogLevelOption): void {
    if (option === undefined) {
      return;
    }
    this.debugLogLevelConfigured = true;
    this.debugLogLevel = normalizeDebugLogLevelOption(option);
    setGlobalDebugLogLevel(this.debugLogLevel ?? false);
  }

  public getDebugLogLevel(): DebugLogLevel | undefined {
    return this.debugLogLevel;
  }

  public hasDebugLogLevelOverride(): boolean {
    return this.debugLogLevelConfigured;
  }

  public async login(
    loginParams: LoginOptions & { forceLogin?: boolean },
  ): Promise<void> {
    this._internalSetTraceContextSigningSecret(loginParams.apiKey);
    this.setDebugLogLevel(loginParams.debugLogLevel);
    if (this.apiUrl && !loginParams.forceLogin) {
      return;
    }
    const generation = this.loginGeneration;
    const pendingLogins = this.pendingLogins;
    const options = {
      ...this.loginParams,
      ...Object.fromEntries(
        Object.entries(loginParams).filter(([k, v]) => !isEmpty(v)),
      ),
    };
    const appUrl =
      options.appUrl ??
      (iso.getEnv("BRAINTRUST_APP_URL") || "https://www.braintrust.dev");
    const orgName = options.orgName ?? iso.getEnv("BRAINTRUST_ORG_NAME");
    const fetch = options.fetch ?? globalThis.fetch;
    const apiKey = options.apiKey ?? (await iso.getBraintrustApiKey());
    if (generation !== this.loginGeneration) {
      throw new Error("Login cancelled by a reset.");
    }
    // Another attempt may have finished while the credential was being read.
    if (this.apiUrl && !loginParams.forceLogin) {
      if (
        this.appUrl !== appUrl ||
        this.loginToken !== (apiKey && HTTPConnection.sanitize_token(apiKey)) ||
        this.activeLoginOrgNameSelector !== orgName ||
        this.fetch !== fetch
      ) {
        throw new Error(
          "Another login completed with different options during credential discovery. To force re-login, pass `forceLogin: true`.",
        );
      }
      return;
    }

    let pending = pendingLogins.get(fetch);
    if (!pending) {
      pending = new Map();
      pendingLogins.set(fetch, pending);
    }
    const key = JSON.stringify([
      appUrl,
      orgName,
      apiKey,
      options.debugLogLevel,
    ]);
    const existing = pending.get(key);
    if (!loginParams.forceLogin && existing) {
      return existing;
    }

    const previousLogin = this.loginQueueTail;
    const loginPromise = (async () => {
      // Each forced login still makes a fresh request, but must not invalidate
      // the metadata promises of loggers already waiting for another login.
      if (previousLogin) {
        await previousLogin.catch(() => {});
      }
      if (generation !== this.loginGeneration) {
        throw new Error("Login cancelled by a reset.");
      }
      // A non-forced login may have been queued while another login was in
      // flight. Recheck the active credentials after that login completes so
      // a queued caller cannot silently replace the shared state's identity.
      if (this.apiUrl && !loginParams.forceLogin) {
        if (
          this.appUrl !== appUrl ||
          this.loginToken !==
            (apiKey && HTTPConnection.sanitize_token(apiKey)) ||
          (this.activeLoginOrgNameSelector !== orgName &&
            (this.orgName === undefined || this.orgName !== orgName)) ||
          this.fetch !== fetch
        ) {
          throw new Error(
            "Another login completed with different options. To force re-login, pass `forceLogin: true`.",
          );
        }
        // copyLoginInfo() may have replaced this queued caller's effective
        // debug level while its login was waiting.
        if (options.debugLogLevel === undefined) {
          this.debugLogLevelConfigured = false;
          this.debugLogLevel = getEnvDebugLogLevel();
          setGlobalDebugLogLevel(undefined);
        } else {
          this.setDebugLogLevel(options.debugLogLevel);
        }
        return;
      }
      const newState = await loginToState({
        ...options,
        appUrl,
        orgName,
        apiKey,
        fetch,
      });
      if (generation !== this.loginGeneration) {
        throw new Error("Login cancelled by a reset.");
      }
      this.copyLoginInfo(newState);
    })();
    this.loginQueueTail = loginPromise;
    pending.set(key, loginPromise);
    try {
      await loginPromise;
    } finally {
      if (this.loginQueueTail === loginPromise) {
        this.loginQueueTail = undefined;
      }
      if (pending.get(key) === loginPromise) {
        pending.delete(key);
      }
    }
  }

  public appConn(): HTTPConnection {
    if (!this._appConn) {
      if (!this.appUrl) {
        throw new Error("Must initialize appUrl before requesting appConn");
      }
      this._appConn = new HTTPConnection(this.appUrl, this.fetch);
    }
    return this._appConn!;
  }

  public apiConn(): HTTPConnection {
    if (!this._apiConn) {
      if (!this.apiUrl) {
        throw new Error("Must initialize apiUrl before requesting apiConn");
      }
      this._apiConn = new HTTPConnection(this.apiUrl, this.fetch);
    }
    return this._apiConn!;
  }

  public proxyConn(): HTTPConnection {
    if (!this.proxyUrl) {
      return this.apiConn();
    }
    if (!this._proxyConn) {
      if (!this.proxyUrl) {
        throw new Error("Must initialize proxyUrl before requesting proxyConn");
      }
      this._proxyConn = new HTTPConnection(
        normalizeProxyConnUrl(this.proxyUrl),
        this.fetch,
      );
    }
    return this._proxyConn!;
  }

  public bgLogger(): BackgroundLogger {
    if (this._overrideBgLogger) {
      return this._overrideBgLogger;
    }
    return this._bgLogger.get();
  }

  public httpLogger(): HTTPBackgroundLogger {
    // this is called for configuration in some end-to-end tests so
    // expose the http bg logger here.
    return this._bgLogger.get();
  }

  public setOverrideBgLogger(logger: BackgroundLogger | null): void {
    this._overrideBgLogger = logger;
  }

  // Should only be called by the login function.
  public loginReplaceApiConn(apiConn: HTTPConnection): void {
    this._bgLogger.get().internalReplaceApiConn(apiConn);
  }

  public disable(): void {
    this._bgLogger.get().disable();
  }

  public enforceQueueSizeLimit(enforce: boolean): void {
    this._bgLogger.get().enforceQueueSizeLimit(enforce);
  }

  // Custom serialization to avoid logging sensitive data
  toJSON(): Record<string, any> {
    return {
      id: this.id,
      orgId: this.orgId,
      orgName: this.orgName,
      appUrl: this.appUrl,
      appPublicUrl: this.appPublicUrl,
      apiUrl: this.apiUrl,
      proxyUrl: this.proxyUrl,
      loggedIn: this.loggedIn,
      // Explicitly exclude loginToken, _apiConn, _appConn, _proxyConn and other sensitive fields
    };
  }

  // Custom inspect for Node.js console.log
  static {
    Object.defineProperty(this.prototype, NODE_INSPECT_CUSTOM, {
      configurable: true,
      writable: true,
      value(this: BraintrustState): string {
        return `BraintrustState {
  id: '${this.id}',
  orgId: ${this.orgId ? `'${this.orgId}'` : "null"},
  orgName: ${this.orgName ? `'${this.orgName}'` : "null"},
  appUrl: ${this.appUrl ? `'${this.appUrl}'` : "null"},
  apiUrl: ${this.apiUrl ? `'${this.apiUrl}'` : "null"},
  proxyUrl: ${this.proxyUrl ? `'${this.proxyUrl}'` : "null"},
  loggedIn: ${this.loggedIn},
  loginToken: '[REDACTED]'
}`;
      },
    });
  }

  // Custom toString
  toString(): string {
    return `BraintrustState(id=${this.id}, org=${this.orgName || "none"}, loggedIn=${this.loggedIn})`;
  }
}

let _globalState: BraintrustState;

/**
 * Initialize the global Braintrust state lazily, it only creates the BraintrustState instance on the first invocation.
 *
 * The state is stored in a global symbol to ensure cross-bundle compatibility.
 *
 * This is invoked on first use; importing the SDK leaves global state untouched.
 *
 * @internal
 */
export function _internalSetInitialState(): void {
  if (_globalState) {
    return;
  }
  const sym = Symbol.for("braintrust-state");
  let existing = (globalThis as any)[sym];
  if (!existing) {
    const state = new BraintrustState({});
    (globalThis as any)[sym] = state;
    existing = state;
  }
  _globalState = existing;
  setDebugLogStateResolver(() => _globalState);
}

/**
 * @internal
 */
export function _internalGetGlobalState(): BraintrustState {
  _internalSetInitialState();
  return _globalState;
}

/**
 * Register a callback to flush OTEL spans. This is called by @braintrust/otel
 * when it initializes a BraintrustSpanProcessor/Exporter.
 *
 * When ensureSpansFlushed is called (e.g., before a BTQL query in scorers),
 * this callback will be invoked to ensure OTEL spans are flushed to the server.
 *
 * Also disables the span cache, since OTEL spans aren't in the local cache
 * and we need BTQL to see the complete span tree (both native + OTEL spans).
 */
export function registerOtelFlush(callback: () => Promise<void>): void {
  _internalGetGlobalState().registerOtelFlush(callback);
  // Disable span cache since OTEL spans aren't in the local cache
  _internalGetGlobalState().spanCache.disable();
}

export class FailedHTTPResponse extends Error {
  public status: number;
  public text: string;
  public data: string;
  public readonly cause?: unknown;

  constructor(status: number, text: string, data: string, cause?: unknown) {
    super(`${status}: ${text} (${data})`);
    this.status = status;
    this.text = text;
    this.data = data;
    this.cause = cause;
  }
}

class HTTPTransportError extends Error {
  public readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "HTTPTransportError";
    this.cause = cause;
  }
}

const httpTransportErrorCauses = new WeakSet<object>();

function recordHTTPTransportError(error: unknown): void {
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    httpTransportErrorCauses.add(error);
  }
}

function rethrowHTTPTransportError(
  error: unknown,
  classifyTransportErrors: boolean,
): never {
  if (classifyTransportErrors) {
    throw new HTTPTransportError(error);
  }
  recordHTTPTransportError(error);
  throw error;
}

export function isLoaderCacheFallbackError(error: unknown): boolean {
  if (error instanceof FailedHTTPResponse) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  if (error instanceof HTTPTransportError) {
    return true;
  }

  return (
    ((typeof error === "object" && error !== null) ||
      typeof error === "function") &&
    httpTransportErrorCauses.has(error)
  );
}

async function readJSONResponse(
  response: Response,
  classifyTransportErrors = false,
) {
  let data: string;
  try {
    data = await response.text();
  } catch (error) {
    rethrowHTTPTransportError(error, classifyTransportErrors);
  }
  return JSON.parse(data);
}

async function checkResponse(resp: Response) {
  if (resp.ok) {
    return resp;
  }

  let data: string;
  try {
    data = await resp.text();
  } catch (error) {
    throw new FailedHTTPResponse(
      resp.status,
      resp.statusText,
      "Unable to read response body",
      error,
    );
  }
  throw new FailedHTTPResponse(resp.status, resp.statusText, data);
}

export class HTTPConnection {
  base_url: string;
  token: string | null;
  headers: Record<string, string>;
  fetch: typeof globalThis.fetch;

  constructor(
    base_url: string,
    fetch: typeof globalThis.fetch,
    private readonly classifyTransportErrors = false,
  ) {
    this.base_url = base_url;
    this.token = null;
    this.headers = {};

    this._reset();
    this.fetch = fetch;
  }

  public setFetch(fetch: typeof globalThis.fetch): void {
    this.fetch = fetch;
  }

  async ping(): Promise<boolean> {
    try {
      const resp = await this.get("ping");
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  make_long_lived(): void {
    // Following a suggestion in https://stackoverflow.com/questions/23013220/max-retries-exceeded-with-url-in-requests
    this._reset();
  }

  static sanitize_token(token: string): string {
    return token.trim();
  }

  set_token(token: string): void {
    token = HTTPConnection.sanitize_token(token);
    this.token = token;
    this._reset();
  }

  // As far as I can tell, you cannot set the retry/backoff factor here
  _reset(): void {
    this.headers = {};
    if (this.token) {
      this.headers["Authorization"] = `Bearer ${this.token}`;
    }
  }

  async get(
    path: string,
    params:
      | Record<string, string | string[] | undefined>
      | undefined = undefined,
    config?: RequestInit,
  ): Promise<Response> {
    const { headers, ...rest } = config || {};
    const url = new URL(_urljoin(this.base_url, path));
    url.search = new URLSearchParams(
      params
        ? Object.entries(params)
            .filter(([_, v]) => v !== undefined)
            .flatMap(([k, v]) =>
              v !== undefined
                ? typeof v === "string"
                  ? [[k, v]]
                  : v.map((x) => [k, x])
                : [],
            )
        : [],
    ).toString();

    // On platforms like Cloudflare, we lose "this" when we make an async call,
    // so we need to bind it again.
    const this_fetch = this.fetch;
    const this_headers = this.headers;
    let response: Response;
    try {
      // Using toString() here makes it work with isomorphic fetch
      response = await this_fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          ...this_headers,
          ...headers,
        },
        keepalive: true,
        ...rest,
      });
    } catch (error) {
      if (config?.signal?.aborted) {
        throw getAbortReason(config.signal);
      }
      rethrowHTTPTransportError(error, this.classifyTransportErrors);
    }
    return await checkResponse(response);
  }

  async post(
    path: string,
    params?: Record<string, unknown> | string,
    config?: RequestInit,
    retries: number = 0,
  ): Promise<Response> {
    const { headers, ...rest } = config || {};
    // On platforms like Cloudflare, we lose "this" when we make an async call,
    // so we need to bind it again.
    const this_fetch = this.fetch;
    const this_base_url = this.base_url;
    const this_headers = this.headers;

    const tries = retries + 1;
    for (let i = 0; i < tries; i++) {
      try {
        let response: Response;
        try {
          response = await this_fetch(_urljoin(this_base_url, path), {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...this_headers,
              ...headers,
            },
            body:
              typeof params === "string"
                ? params
                : params
                  ? JSON.stringify(params)
                  : undefined,
            keepalive: true,
            ...rest,
          });
        } catch (error) {
          if (config?.signal?.aborted) {
            throw getAbortReason(config.signal);
          }
          rethrowHTTPTransportError(error, this.classifyTransportErrors);
        }
        return await checkResponse(response);
      } catch (error) {
        if (config?.signal?.aborted) {
          throw getAbortReason(config.signal);
        }
        if (i === tries - 1 || !isRetryableHTTPError(error)) {
          throw error;
        }

        debugLogger.debug(
          `Retrying API request ${path} after ${formatHTTPError(error)}`,
        );
        const sleepTimeMs =
          HTTP_RETRY_BASE_SLEEP_TIME_S * 1000 * 2 ** i +
          Math.random() * HTTP_RETRY_JITTER_MS;
        debugLogger.info(
          `Sleeping for ${sleepTimeMs}ms before retrying API request`,
        );
        await waitForRetry(sleepTimeMs, config?.signal);
      }
    }

    throw new Error("Unexpected retry state");
  }

  async get_json(
    object_type: string,
    args: Record<string, string | string[] | undefined> | undefined = undefined,
    retries: number = 0,
    signal?: AbortSignal,
  ): Promise<any> {
    const tries = retries + 1;
    for (let i = 0; i < tries; i++) {
      try {
        const resp = await this.get(`${object_type}`, args, { signal });
        return await readJSONResponse(resp, this.classifyTransportErrors);
      } catch (e) {
        if (signal?.aborted) {
          throw getAbortReason(signal);
        }
        if (i < tries - 1) {
          debugLogger.debug(
            `Retrying API request ${object_type} ${JSON.stringify(args)} ${
              (e as any).status
            } ${(e as any).text}`,
          );
          const sleepTimeS = HTTP_RETRY_BASE_SLEEP_TIME_S * 2 ** i;
          debugLogger.info(
            `Sleeping for ${sleepTimeS}s before retrying API request`,
          );
          await waitForRetry(sleepTimeS * 1000, signal);
          continue;
        }
        throw e;
      }
    }
  }

  async post_json(
    object_type: string,
    args: Record<string, unknown> | string | undefined = undefined,
    signal?: AbortSignal,
  ): Promise<any> {
    const resp = await this.post(`${object_type}`, args, {
      headers: { "Content-Type": "application/json" },
      signal,
    });
    return await readJSONResponse(resp, this.classifyTransportErrors);
  }

  // Custom inspect for Node.js console.log
  static {
    Object.defineProperty(this.prototype, NODE_INSPECT_CUSTOM, {
      configurable: true,
      writable: true,
      value(this: HTTPConnection): string {
        return `HTTPConnection {
  base_url: '${this.base_url}',
  token: '[REDACTED]'
}`;
      },
    });
  }

  // Custom toString
  toString(): string {
    return `HTTPConnection(${this.base_url})`;
  }
}

export interface ObjectMetadata {
  id: string;
  name: string;
  fullInfo: Record<string, unknown>;
}

export interface ProjectExperimentMetadata {
  project: ObjectMetadata;
  experiment: ObjectMetadata;
}

export interface ProjectDatasetMetadata {
  project: ObjectMetadata;
  dataset: ObjectMetadata;
}

interface OrgProjectMetadata {
  org_id: string;
  project: ObjectMetadata;
}

interface LinkArgs {
  org_name?: string;
  app_url?: string;
}

type ProjectMetadataArgs = {
  project_group_name?: string;
  project_name?: string;
  project_id?: string;
};

export interface AttachmentParams {
  data: string | Blob | ArrayBuffer;
  filename: string;
  contentType: string;
  state?: BraintrustState;
}

export interface ExternalAttachmentParams {
  url: string;
  filename: string;
  contentType: string;
  state?: BraintrustState;
}

export abstract class BaseAttachment {
  readonly reference!: AttachmentReference;
  abstract upload(): Promise<AttachmentStatus>;
  abstract data(): Promise<Blob>;
  abstract debugInfo(): Record<string, unknown>;
}

type DatasetPipelineDeferredJSONAttachmentHook = (
  data: unknown,
  options?: { filename?: string; pretty?: boolean },
) => object;

declare global {
  // Set by the bt dataset pipeline runner so JSONAttachment can be represented
  // as a destination-uploaded marker during transform.
  // eslint-disable-next-line no-var
  var __BT_DATASET_PIPELINE_DEFER_JSON_ATTACHMENT__:
    | DatasetPipelineDeferredJSONAttachmentHook
    | undefined;
}

/**
 * Represents an attachment to be uploaded and the associated metadata.
 * `Attachment` objects can be inserted anywhere in an event, allowing you to
 * log arbitrary file data. The SDK will asynchronously upload the file to
 * object storage and replace the `Attachment` object with an
 * `AttachmentReference`.
 */
export class Attachment extends BaseAttachment {
  /**
   * The object that replaces this `Attachment` at upload time.
   */
  readonly reference: BraintrustAttachmentReference;

  private readonly uploader: LazyValue<AttachmentStatus>;
  private readonly _data: LazyValue<Blob>;
  private readonly state?: BraintrustState;
  // For debug logging only.
  private readonly dataDebugString: string;

  /**
   * Construct an attachment.
   *
   * @param param A parameter object with:
   *
   * `data`: A string representing the path of the file on disk, or a
   * `Blob`/`ArrayBuffer` with the file's contents. The caller is responsible
   * for ensuring the file/blob/buffer is not modified until upload is complete.
   *
   * `filename`: The desired name of the file in Braintrust after uploading.
   * This parameter is for visualization purposes only and has no effect on
   * attachment storage.
   *
   * `contentType`: The MIME type of the file.
   *
   * `state`: (Optional) For internal use.
   */
  constructor({ data, filename, contentType, state }: AttachmentParams) {
    super();
    this.reference = {
      type: BRAINTRUST_ATTACHMENT,
      filename,
      content_type: contentType,
      key: newId(),
    };
    this.state = state;
    this.dataDebugString = typeof data === "string" ? data : "<in-memory data>";

    this._data = this.initData(data);
    this.uploader = this.initUploader();
  }

  /**
   * On first access, (1) reads the attachment from disk if needed, (2)
   * authenticates with the data plane to request a signed URL, (3) uploads to
   * object store, and (4) updates the attachment.
   *
   * @returns The attachment status.
   */
  async upload(): Promise<AttachmentStatus> {
    return await this.uploader.get();
  }

  /**
   * The attachment contents. This is a lazy value that will read the attachment contents from disk or memory on first access.
   */
  async data(): Promise<Blob> {
    return this._data.get();
  }

  /**
   * A human-readable description for logging and debugging.
   *
   * @returns The debug object. The return type is not stable and may change in
   * a future release.
   */
  debugInfo(): Record<string, unknown> {
    return {
      inputData: this.dataDebugString,
      reference: this.reference,
      state: this.state,
    };
  }

  private initUploader(): LazyValue<AttachmentStatus> {
    const withRetry = async <T>(request: () => Promise<T>): Promise<T> => {
      const retries = automaticAttachmentOriginals.has(this) ? 8 : 0;
      for (let attempt = 0; ; attempt++) {
        try {
          return await request();
        } catch (error) {
          if (attempt >= retries || !isRetryableHTTPError(error)) throw error;
          await waitForRetry(500 * 2 ** attempt);
        }
      }
    };
    const doUpload = async (conn: HTTPConnection, orgId: string) => {
      const requestParams = {
        key: this.reference.key,
        filename: this.reference.filename,
        content_type: this.reference.content_type,
        org_id: orgId,
      };
      const [metadataPromiseResult, dataPromiseResult] =
        await Promise.allSettled([
          withRetry(() => conn.post("/attachment", requestParams)),
          this._data.get(),
        ]);
      if (metadataPromiseResult.status === "rejected") {
        const errorStr = JSON.stringify(metadataPromiseResult.reason);
        throw new Error(
          `Failed to request signed URL from API server: ${errorStr}`,
        );
      }
      if (dataPromiseResult.status === "rejected") {
        const errorStr = JSON.stringify(dataPromiseResult.reason);
        throw new Error(`Failed to read file: ${errorStr}`);
      }
      const metadataResponse = metadataPromiseResult.value;
      const data = dataPromiseResult.value;

      let signedUrl: string | undefined;
      let headers: Record<string, string>;
      try {
        ({ signedUrl, headers } = z
          .object({
            signedUrl: z.string().url(),
            headers: z.record(z.string()),
          })
          .parse(await metadataResponse.json()));
      } catch (error) {
        if (error instanceof ZodError) {
          const errorStr = JSON.stringify(error.flatten());
          throw new Error(`Invalid response from API server: ${errorStr}`);
        }
        throw error;
      }

      addAzureBlobHeaders(headers, signedUrl);

      // TODO multipart upload.
      let objectStoreResponse: Response | undefined;
      try {
        objectStoreResponse = await withRetry(async () =>
          checkResponse(
            await fetch(signedUrl, {
              method: "PUT" satisfies RequestInit["method"],
              headers,
              body: data,
            }),
          ),
        );
        await objectStoreResponse.body?.cancel();
      } catch (error) {
        if (error instanceof FailedHTTPResponse) {
          throw new Error(
            `Failed to upload attachment to object store: ${error.status} ${error.text} ${error.data}`,
          );
        }
        throw error;
      }

      return { signedUrl, metadataResponse, objectStoreResponse };
    };

    // Catches error messages and updates the attachment status.
    const errorWrapper = async () => {
      const status: AttachmentStatus = { upload_status: "done" };

      const state = this.state ?? _internalGetGlobalState();
      await withRetry(() => state.login({}));

      const conn = state.apiConn();
      const orgId = state.orgId ?? "";

      try {
        await doUpload(conn, orgId);
      } catch (error) {
        status.upload_status = "error";
        status.error_message =
          error instanceof Error ? error.message : JSON.stringify(error);
      }

      const requestParams = {
        key: this.reference.key,
        org_id: orgId,
        status,
      };
      const statusResponse = await withRetry(() =>
        conn.post("/attachment/status", requestParams),
      );
      await statusResponse.body?.cancel();
      if (!statusResponse.ok) {
        const errorStr = JSON.stringify(statusResponse);
        throw new Error(`Couldn't log attachment status: ${errorStr}`);
      }

      return status;
    };

    return new LazyValue(errorWrapper);
  }

  private initData(data: string | Blob | ArrayBuffer): LazyValue<Blob> {
    if (typeof data === "string") {
      this.ensureFileReadable(data);

      const readFile = iso.readFile;
      if (!readFile) {
        throw new Error(
          `This platform does not support reading the filesystem. Construct the Attachment
with a Blob/ArrayBuffer, or run the program on Node.js.`,
        );
      }
      // This could stream the file in the future.
      return new LazyValue(
        async () => new Blob([Uint8Array.from(await readFile(data))]),
      );
    } else {
      return new LazyValue(async () => new Blob([data]));
    }
  }

  private ensureFileReadable(data: string) {
    const statSync = iso.statSync;
    if (!statSync) {
      throw new Error(
        `This platform does not support reading the filesystem. Construct the Attachment
with a Blob/ArrayBuffer, or run the program on Node.js.`,
      );
    }

    try {
      statSync(data);
    } catch (e) {
      debugLogger.warn(`Failed to read file: ${e}`);
    }
  }
}

/**
 * Represents an attachment that resides in an external object store and the associated metadata.
 *
 * `ExternalAttachment` objects can be inserted anywhere in an event, similar to
 * `Attachment` objects, but they reference files that already exist in an external
 * object store rather than requiring upload. The SDK will replace the `ExternalAttachment`
 * object with an `AttachmentReference` during logging.
 */
export class ExternalAttachment extends BaseAttachment {
  /**
   * The object that replaces this `ExternalAttachment` at upload time.
   */
  readonly reference: ExternalAttachmentReference;

  private readonly _data: LazyValue<Blob>;
  private readonly state?: BraintrustState;

  /**
   * Construct an external attachment.
   *
   * @param param A parameter object with:
   *
   * `url`: The fully qualified URL of the file in the external object store.
   *
   * `filename`: The desired name of the file in Braintrust after uploading.
   * This parameter is for visualization purposes only and has no effect on
   * attachment storage.
   *
   * `contentType`: The MIME type of the file.
   *
   * `state`: (Optional) For internal use.
   */
  constructor({ url, filename, contentType, state }: ExternalAttachmentParams) {
    super();
    this.reference = {
      type: EXTERNAL_ATTACHMENT,
      filename,
      content_type: contentType,
      url,
    };

    this._data = this.initData();
  }

  /**
   * For ExternalAttachment, this is a no-op since the data already resides
   * in the external object store. It marks the attachment as already uploaded.
   *
   * @returns The attachment status, which will always indicate success.
   */
  async upload(): Promise<{ upload_status: "done" }> {
    return { upload_status: "done" as const };
  }

  /**
   * The attachment contents. This is a lazy value that will read the attachment contents from the external object store on first access.
   */
  async data(): Promise<Blob> {
    return this._data.get();
  }

  /**
   * A human-readable description for logging and debugging.
   *
   * @returns The debug object. The return type is not stable and may change in
   * a future release.
   */
  debugInfo(): Record<string, unknown> {
    return {
      url: this.reference.url,
      reference: this.reference,
      state: this.state,
    };
  }

  private initData(): LazyValue<Blob> {
    return new LazyValue(async () => {
      const readonly = new ReadonlyAttachment(this.reference, this.state);
      return await readonly.data();
    });
  }
}

const attachmentMetadataSchema = z.object({
  downloadUrl: z.string(),
  status: attachmentStatusSchema,
});

type AttachmentMetadata = {
  downloadUrl: string;
  status: AttachmentStatus;
};

/**
 * A readonly alternative to `Attachment`, which can be used for fetching
 * already-uploaded Attachments.
 */
export class ReadonlyAttachment {
  /**
   * Attachment metadata.
   */
  readonly reference: AttachmentReference;

  private readonly _data: LazyValue<Blob>;
  private readonly state?: BraintrustState;

  /**
   * Construct a ReadonlyAttachment.
   *
   * @param reference The `AttachmentReference` that should be read by the
   * `ReadonlyAttachment` object.
   * @param state (Optional) For internal use.
   * @returns The new `ReadonlyAttachment` object.
   */
  constructor(reference: AttachmentReference, state?: BraintrustState) {
    this.reference = reference;
    this.state = state;
    this._data = this.initDownloader();
  }

  /**
   * The attachment contents. This is a lazy value that will read the attachment
   * contents from the object store on first access.
   */
  async data(): Promise<Blob> {
    return this._data.get();
  }

  /**
   * Returns the attachment contents as a base64-encoded URL that is suitable
   * for use in a prompt.
   *
   * @returns The attachment contents as a base64-encoded URL.
   */
  async asBase64Url(): Promise<string> {
    const buf = await (await this.data()).arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    return `data:${this.reference.content_type};base64,${base64}`;
  }

  /**
   * Fetch the attachment metadata, which includes a downloadUrl and a status.
   * This will re-fetch the status each time in case it changes over time.
   */
  async metadata(): Promise<AttachmentMetadata> {
    const state = this.state ?? _internalGetGlobalState();
    await state.login({});

    const params: Record<string, string> = {
      filename: this.reference.filename,
      content_type: this.reference.content_type,
      org_id: state.orgId || "",
    };
    if (this.reference.type === "braintrust_attachment") {
      params.key = this.reference.key;
    } else if (this.reference.type === "external_attachment") {
      params.url = this.reference.url;
    }
    const resp = await state.apiConn().get("/attachment", params);
    if (!resp.ok) {
      const errorStr = JSON.stringify(resp);
      throw new Error(`Invalid response from API server: ${errorStr}`);
    }

    return attachmentMetadataSchema.parse(await resp.json());
  }

  /**
   * Fetch the attachment upload status. This will re-fetch the status each time
   * in case it changes over time.
   */
  async status(): Promise<AttachmentStatus> {
    return (await this.metadata()).status;
  }

  private initDownloader(): LazyValue<Blob> {
    const download = async () => {
      const { downloadUrl, status } = await this.metadata();

      if (status.upload_status !== "done") {
        throw new Error(
          `Expected attachment status "done", got "${status.upload_status}"`,
        );
      }

      const objResponse = await fetch(downloadUrl);
      if (objResponse.status !== 200) {
        const error = await objResponse.text();
        throw new Error(`Couldn't download attachment: ${error}`);
      }

      return await objResponse.blob();
    };

    return new LazyValue(download);
  }
}

/**
 * Represents a JSON object that should be stored as an attachment.
 *
 * `JSONAttachment` is a convenience function that creates an `Attachment`
 * from JSON data. It's particularly useful for large JSON objects that
 * would otherwise bloat the trace size.
 *
 * The JSON data is automatically serialized and stored as an attachment
 * with content type "application/json".
 */
export class JSONAttachment extends Attachment {
  /**
   * Construct a JSONAttachment from a JSON-serializable object.
   *
   * @param data The JSON object to attach. Must be JSON-serializable.
   * @param options Additional options:
   * - `filename`: The filename for the attachment (defaults to "data.json")
   * - `pretty`: Whether to pretty-print the JSON (defaults to false)
   * - `state`: (Optional) For internal use.
   *
   * @example
   * ```typescript
   * const largeTranscript = [
   *   { role: "user", content: "..." },
   *   { role: "assistant", content: "..." },
   *   // ... many more messages
   * ];
   *
   * logger.log({
   *   input: {
   *     type: "chat",
   *     transcript: new JSONAttachment(largeTranscript, { filename: "transcript.json" })
   *   }
   * });
   * ```
   */
  constructor(
    data: unknown,
    options?: {
      filename?: string;
      pretty?: boolean;
      state?: BraintrustState;
    },
  ) {
    const { filename = "data.json", pretty = false, state } = options ?? {};
    const deferredJsonAttachment =
      globalThis.__BT_DATASET_PIPELINE_DEFER_JSON_ATTACHMENT__;
    if (deferredJsonAttachment) {
      super({
        data: new Blob([]),
        filename,
        contentType: "application/json",
        state,
      });
      return deferredJsonAttachment(data, {
        filename,
        pretty,
      }) as unknown as JSONAttachment;
    }

    // Serialize the JSON data
    const jsonString = pretty
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);
    const blob = new Blob([jsonString], { type: "application/json" });

    super({
      data: blob,
      filename,
      contentType: "application/json",
      state,
    });
  }
}

export function logFeedbackImpl(
  state: BraintrustState,
  parentObjectType: SpanObjectTypeV3,
  parentObjectId: LazyValue<string>,
  {
    id,
    expected,
    scores,
    metadata: inputMetadata,
    tags,
    comment,
    source: inputSource,
  }: LogFeedbackFullArgs,
): void {
  const source = inputSource ?? "external";

  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`source must be one of ${VALID_SOURCES}`);
  }

  if (
    isEmpty(scores) &&
    isEmpty(expected) &&
    isEmpty(tags) &&
    isEmpty(comment)
  ) {
    throw new Error(
      "At least one of scores, expected, tags, or comment must be specified",
    );
  }

  const validatedEvent = validateAndSanitizeExperimentLogPartialArgs({
    scores,
    metadata: inputMetadata,
    expected,
    tags,
  });

  const { metadata, ...rawUpdateEvent } = deepCopyEvent(validatedEvent);
  const updateEvent = Object.fromEntries(
    Object.entries(rawUpdateEvent).filter(([_, v]) => !isEmpty(v)),
  );

  const parentIds = async () =>
    new SpanComponentsV3({
      object_type: parentObjectType,
      object_id: await parentObjectId.get(),
    }).objectIdFields();

  if (Object.keys(updateEvent).length > 0) {
    const record = new LazyValue(async () => {
      return {
        id,
        ...updateEvent,
        ...(await parentIds()),
        [AUDIT_SOURCE_FIELD]: source,
        [AUDIT_METADATA_FIELD]: metadata,
        [IS_MERGE_FIELD]: true,
      };
    });
    state.bgLogger().log([record]);
  }

  if (!isEmpty(comment)) {
    const record = new LazyValue(async () => {
      return {
        id: uuidv4(),
        created: new Date().toISOString(),
        origin: {
          // NOTE: We do not know (or care?) what the transaction id of the row that
          // we're commenting on is here, so we omit it.
          id,
        },
        comment: {
          text: comment,
        },
        ...(await parentIds()),
        [AUDIT_SOURCE_FIELD]: source,
        [AUDIT_METADATA_FIELD]: metadata,
      };
    });
    state.bgLogger().log([record]);
  }
}

export function updateSpanImpl({
  state,
  parentObjectType,
  parentObjectId,
  id,
  root_span_id,
  span_id,
  event,
}: {
  state: BraintrustState;
  parentObjectType: SpanObjectTypeV3;
  parentObjectId: LazyValue<string>;
  id: string;
  root_span_id: string | undefined;
  span_id: string | undefined;
  event: Omit<Partial<ExperimentEvent>, "id" | "root_span_id" | "span_id">;
}): void {
  if (isEmpty(root_span_id) !== isEmpty(span_id)) {
    throw new Error("both root_span_id and span_id must be set, or neither");
  }
  const hasExplicitSpanIds =
    root_span_id !== undefined && span_id !== undefined;
  const updateEvent = deepCopyEvent(
    validateAndSanitizeExperimentLogPartialArgs({
      ...event,
      id,
      ...(hasExplicitSpanIds ? { root_span_id, span_id } : {}),
    } as Partial<ExperimentEvent>),
  );

  const parentIds = async () =>
    new SpanComponentsV3({
      object_type: parentObjectType,
      object_id: await parentObjectId.get(),
    }).objectIdFields();

  const record = new LazyValue(
    async () =>
      customizeSpanExport({
        id,
        ...updateEvent,
        ...(await parentIds()),
        [IS_MERGE_FIELD]: true,
      }) as BackgroundLogEvent,
  );
  state.bgLogger().log([record]);
}

/**
 * Update a span using the output of `span.export()`. It is important that you only resume updating
 * to a span once the original span has been fully written and flushed, since otherwise updates to
 * the span may conflict with the original span.
 *
 * @param exported The output of `span.export()`.
 * @param event The event data to update the span with. See {@link Experiment.log} for a full list of valid fields.
 * @param state (optional) Login state to use. If not provided, the global state will be used.
 */
export function updateSpan({
  exported,
  state,
  ...event
}: { exported: string } & Omit<
  Partial<ExperimentEvent>,
  "id" | "root_span_id" | "span_id"
> &
  OptionalStateArg): void {
  const resolvedState = state ?? _internalGetGlobalState();
  const components = SpanComponentsV4.fromStr(exported);

  if (!components.data.row_id) {
    throw new Error("Exported span must have a row id");
  }

  updateSpanImpl({
    state: resolvedState,
    parentObjectType: components.data.object_type,
    parentObjectId: new LazyValue(
      spanComponentsToObjectIdLambda(resolvedState, components),
    ),
    id: components.data.row_id,
    root_span_id: components.data.root_span_id,
    span_id: components.data.span_id,
    event,
  });
}

/** @internal Rehydrate an exported root span so work can continue in another process. */
export function _internalResumeSpan({
  exported,
  state,
}: {
  exported: string;
  state?: BraintrustState;
}): Span {
  const resolvedState = state ?? _internalGetGlobalState();
  const components = SpanComponentsV4.fromStr(exported);
  const { row_id, root_span_id, span_id } = components.data;
  if (!row_id || !root_span_id || !span_id) {
    throw new Error("Only exported root spans can be resumed");
  }
  return new SpanImpl({
    state: resolvedState,
    parentObjectType: components.data.object_type,
    parentObjectId: new LazyValue(
      spanComponentsToObjectIdLambda(resolvedState, components),
    ),
    parentComputeObjectMetadataArgs: undefined,
    parentSpanIds: { parentSpanIds: [], rootSpanId: root_span_id },
    spanId: span_id,
    event: { id: row_id },
    propagatedEvent: (components.data.propagated_event ?? undefined) as
      | StartSpanEventArgs
      | undefined,
    [RESUME_SPAN_WITHOUT_INITIAL_WRITE]: true,
  });
}

/**
 * An opaque W3C trace-context, as returned by
 * {@link extractTraceContextFromHeaders}.
 *
 * Carries the relevant W3C headers (`traceparent`, `baggage`, `tracestate`).
 * Callers MUST treat it as opaque and pass it straight to
 * `startSpan({ parent })`.
 */
export type PropagationContext = Record<string, string>;

export interface ParentSpanIds {
  spanId: string;
  rootSpanId: string;
}

export interface MultiParentSpanIds {
  parentSpanIds: string[];
  rootSpanId: string;
}

function spanComponentsToObjectIdLambda(
  state: BraintrustState,
  components: SpanComponentsV3,
): () => Promise<string> {
  if (components.data.object_id) {
    const ret = components.data.object_id;
    return async () => ret;
  }
  if (!components.data.compute_object_metadata_args) {
    throw new Error(
      "Impossible: must provide either objectId or computeObjectMetadataArgs",
    );
  }
  switch (components.data.object_type) {
    case SpanObjectTypeV3.EXPERIMENT:
      throw new Error(
        "Impossible: computeObjectMetadataArgs not supported for experiments",
      );
    case SpanObjectTypeV3.PLAYGROUND_LOGS:
      throw new Error(
        "Impossible: computeObjectMetadataArgs not supported for prompt sessions",
      );
    case SpanObjectTypeV3.PROJECT_LOGS:
      return async () =>
        (
          await computeLoggerMetadata(state, {
            ...components.data.compute_object_metadata_args,
          })
        ).project.id;
    default:
      const x: never = components.data.object_type;
      throw new Error(`Unknown object type: ${x}`);
  }
}

// Utility function to resolve the object ID of a SpanComponentsV3 object. This
// function may trigger a login to braintrust if the object ID is encoded
// "lazily".
export async function spanComponentsToObjectId({
  components,
  state,
}: {
  components: SpanComponentsV3;
  state?: BraintrustState;
}): Promise<string> {
  return await spanComponentsToObjectIdLambda(
    state ?? _internalGetGlobalState(),
    components,
  )();
}

export const ERR_PERMALINK = "https://braintrust.dev/error-generating-link";

function getErrPermlink(msg: string) {
  if (msg == "") {
    return ERR_PERMALINK;
  }
  return `${ERR_PERMALINK}?msg=${encodeURIComponent(msg)}`;
}

function _getAppUrl(appUrl?: string | null): string {
  return (
    appUrl || iso.getEnv("BRAINTRUST_APP_URL") || "https://www.braintrust.dev"
  );
}

function _getOrgName(orgName?: string | null): string | undefined {
  return orgName || iso.getEnv("BRAINTRUST_ORG_NAME") || undefined;
}

/**
 * Return the base URL for links (e.g. https://braintrust.dev/app/my-org-name)
 * if we have the info, otherwise return null.
 * Resolution order: state -> linkArgs -> env var
 */
function _getLinkBaseUrl(
  state: BraintrustState,
  linkArgs?: LinkArgs,
): string | null {
  const appUrl = _getAppUrl(state.appUrl || linkArgs?.app_url);
  const orgName = _getOrgName(state.orgName || linkArgs?.org_name);
  if (!orgName) {
    return null;
  }
  return `${appUrl}/app/${orgName}`;
}

/**
 * Format a permalink to the Braintrust application for viewing the span
 * represented by the provided `slug`.
 *
 * Links can be generated at any time, but they will only become viewable after
 * the span and its root have been flushed to the server and ingested.
 *
 * If you have a `Span` object, use {@link Span.link} instead.
 *
 * @param slug The identifier generated from {@link Span.export}.
 * @param opts Optional arguments.
 * @param opts.state The login state to use. If not provided, the global state will be used.
 * @param opts.orgName The org name to use. If not provided, the org name will be inferred from the state.
 * @param opts.appUrl The app URL to use. If not provided, the app URL will be inferred from the state.
 * @returns A permalink to the exported span.
 */
export async function permalink(
  slug: string,
  opts?: {
    state?: BraintrustState;
    orgName?: string;
    appUrl?: string;
  },
): Promise<string> {
  // Noop spans have an empty slug, so return a dummy permalink.
  if (slug === "") {
    return NOOP_SPAN_PERMALINK;
  }

  const state = opts?.state ?? _internalGetGlobalState();
  const getOrgName = async () => {
    if (opts?.orgName) {
      return opts.orgName;
    }
    await state.login({});
    if (!state.orgName) {
      throw new Error("provide-org-or-login"); // this is caught below
    }
    return state.orgName;
  };
  const getAppUrl = async () => {
    if (opts?.appUrl) {
      return opts.appUrl;
    }
    await state.login({});
    if (!state.appUrl) {
      throw new Error("provide-app-url-or-login"); // this is caught below
    }
    return state.appUrl;
  };

  try {
    const components = SpanComponentsV4.fromStr(slug);
    const object_type = spanObjectTypeV3ToString(components.data.object_type);
    const [orgName, appUrl, object_id] = await Promise.all([
      getOrgName(),
      getAppUrl(),
      spanComponentsToObjectId({ components, state }),
    ]);
    const id = components.data.row_id;
    if (!id) {
      throw new Error("Span slug does not refer to an individual row");
    }
    const urlParams = new URLSearchParams({ object_type, object_id, id });
    return `${appUrl}/app/${orgName}/object?${urlParams}`;
  } catch (e) {
    if (e instanceof FailedHTTPResponse) {
      return getErrPermlink(`http-error-${e.status}`);
    }
    return getErrPermlink(e instanceof Error ? e.message : String(e));
  }
}

// IMPORTANT NOTE: This function may pass arguments which override those in the
// main argument set, so if using this in a spread, like `SpanImpl({ ...args,
// ...startSpanParentArgs(...)})`, make sure to put startSpanParentArgs after
// the original argument set.
export function startSpanParentArgs(args: {
  state: BraintrustState;
  // `parent` may be an exported slug string or an opaque W3C trace-context
  // (from `extractTraceContextFromHeaders`).
  parent: string | PropagationContext | undefined;
  parentObjectType: SpanObjectTypeV3;
  parentObjectId: LazyValue<string>;
  parentComputeObjectMetadataArgs: Record<string, any> | undefined;
  parentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined;
  propagatedEvent: StartSpanEventArgs | undefined;
  propagatedState?: PropagatedState | undefined;
}): {
  parentObjectType: SpanObjectTypeV3;
  parentObjectId: LazyValue<string>;
  parentComputeObjectMetadataArgs: Record<string, any> | undefined;
  parentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined;
  propagatedEvent: StartSpanEventArgs | undefined;
  propagatedState: PropagatedState | undefined;
} {
  let argParentObjectId: LazyValue<string> | undefined = undefined;
  let argParentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined =
    undefined;
  let argPropagatedEvent: StartSpanEventArgs | undefined = undefined;
  let argPropagatedState: PropagatedState | undefined = undefined;
  const { parentSlug, propagatedState: parentPropagatedState } =
    normalizeParent(args.parent, args.state);
  if (parentSlug) {
    if (args.parentSpanIds) {
      throw new Error("Cannot specify both parent and parentSpanIds");
    }
    const parentComponents = SpanComponentsV4.fromStr(parentSlug);
    if (args.parentObjectType !== parentComponents.data.object_type) {
      throw new Error(
        `Mismatch between expected span parent object type ${args.parentObjectType} and provided type ${parentComponents.data.object_type}`,
      );
    }

    // For logger/span method calls that receive a W3C parent, the inbound
    // context links this span to the upstream trace ids, but the span still
    // belongs to the current Braintrust project/experiment and should propagate
    // that current parent onward. Keep the receiver's object id/metadata and
    // only forward opaque W3C state (trace-flags/tracestate), not the inbound
    // braintrust.parent fallback.
    argParentObjectId = args.parentObjectId;
    if (
      parentComponents.data.row_id &&
      parentSpanIdsUsable(
        parentComponents.data.span_id,
        parentComponents.data.root_span_id,
      )
    ) {
      argParentSpanIds = {
        spanId: parentComponents.data.span_id,
        rootSpanId: parentComponents.data.root_span_id,
      };
    }
    argPropagatedEvent =
      args.propagatedEvent ??
      ((parentComponents.data.propagated_event ?? undefined) as
        | StartSpanEventArgs
        | undefined);
    const propagatedState = args.propagatedState ?? parentPropagatedState;
    if (propagatedState) {
      const { braintrustParent: _ignoredBraintrustParent, ...w3cState } =
        propagatedState;
      argPropagatedState = w3cState;
    }
  } else {
    argParentObjectId = args.parentObjectId;
    argParentSpanIds = args.parentSpanIds;
    argPropagatedEvent = args.propagatedEvent;
    argPropagatedState = args.propagatedState;
  }

  return {
    parentObjectType: args.parentObjectType,
    parentObjectId: argParentObjectId,
    parentComputeObjectMetadataArgs: args.parentComputeObjectMetadataArgs,
    parentSpanIds: argParentSpanIds,
    propagatedEvent: argPropagatedEvent,
    propagatedState: argPropagatedState,
  };
}

export class Logger implements Exportable {
  private state: BraintrustState;
  private lazyMetadata: LazyValue<OrgProjectMetadata>;
  private computeMetadataArgs: ProjectMetadataArgs | undefined;
  private linkArgs: LinkArgs | undefined;
  private lastStartTime: number;
  private lazyId: LazyValue<string>;
  private calledStartSpan: boolean;
  private baselineTraceId?: string;
  private readonly autoCaptureAttachments: boolean | undefined;

  // For type identification.
  public kind = "logger" as const;

  constructor(
    state: BraintrustState,
    lazyMetadata: LazyValue<OrgProjectMetadata>,
    options: {
      computeMetadataArgs?: ProjectMetadataArgs;
      linkArgs?: LinkArgs;
      autoCaptureAttachments?: boolean;
    } = {},
  ) {
    this.lazyMetadata = lazyMetadata;
    this.computeMetadataArgs = options.computeMetadataArgs;
    this.linkArgs = options.linkArgs;
    this.lastStartTime = getCurrentUnixTimestamp();
    this.lazyId = new LazyValue(() => this.id);
    this.calledStartSpan = false;
    this.autoCaptureAttachments = options.autoCaptureAttachments;
    this.state = state;
  }

  public get org_id(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).org_id;
    })();
  }

  public get project(): Promise<ObjectMetadata> {
    return (async () => {
      return (await this.lazyMetadata.get()).project;
    })();
  }

  public get id(): Promise<string> {
    return (async () => (await this.project).id)();
  }

  public get loggingState(): BraintrustState {
    return this.state;
  }

  static {
    Object.defineProperty(this.prototype, CAPTURE_ATTACHMENTS, {
      configurable: true,
      get(this: Logger): boolean {
        return this.autoCaptureAttachments ?? autoCaptureAttachmentsFromEnv();
      },
    });
  }

  private parentObjectType() {
    return SpanObjectTypeV3.PROJECT_LOGS;
  }

  /**
   * Log a single event. The event will be batched and uploaded behind the scenes. Call and await {@link Logger.flush} to ensure the event has been uploaded.
   *
   * @param event The event to log.
   * @param event.input: (Optional) the arguments that uniquely define a user input (an arbitrary, JSON serializable object).
   * @param event.output: (Optional) the output of your application, including post-processing (an arbitrary, JSON serializable object), that allows you to determine whether the result is correct or not. For example, in an app that generates SQL queries, the `output` should be the _result_ of the SQL query generated by the model, not the query itself, because there may be multiple valid queries that answer a single question.
   * @param event.expected: (Optional) the ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not. Braintrust currently does not compare `output` to `expected` for you, since there are so many different ways to do that correctly. Instead, these values are just used to help you navigate while digging into analyses. However, we may later use these values to re-score outputs or fine-tune your models.
   * @param event.error: (Optional) The error that occurred, if any. If you use tracing to run an experiment, errors are automatically logged when your code throws an exception.
   * @param event.scores: (Optional) a dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare logs.
   * @param event.metadata: (Optional) a dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings.
   * @param event.metrics: (Optional) a dictionary of metrics to log. The following keys are populated automatically: "start", "end".
   * @param event.id: (Optional) a unique identifier for the event. If you don't provide one, BrainTrust will generate one for you.
   * @param options Additional logging options
   * @param options.allowConcurrentWithSpans in rare cases where you need to log at the top level separately from spans on the logger elsewhere, set this to true.
   * @returns The `id` of the logged event.
   */
  public log(
    event: Readonly<StartSpanEventArgs>,
    options?: { allowConcurrentWithSpans?: boolean },
  ): string {
    if (this.calledStartSpan && !options?.allowConcurrentWithSpans) {
      throw new Error(
        "Cannot run toplevel `log` method while using spans. To log to the span, call `logger.traced` and then log with `span.log`",
      );
    }

    const span = this.startSpanImpl({ startTime: this.lastStartTime, event });
    this.lastStartTime = span.end();
    return span.id;
  }

  /**
   * Capture an application log as one complete row, correlated with the active
   * Braintrust or OpenTelemetry span. Without an active span, logs from this
   * logger share a baseline trace ID.
   */
  private emitLog(
    body: unknown,
    level: ApplicationLogLevel,
    options?: ApplicationLogOptions,
  ): string {
    const rendered = renderLogBody(body, options);
    const timestamp = getCurrentUnixTimestamp();
    const current = this.state.contextManager.getParentSpanIds();
    // Supply all fields in the initial write. Calling span.end() here would
    // enqueue an unnecessary second write for this instantaneous event.
    const span = new SpanImpl({
      state: this.state,
      parentObjectType: this.parentObjectType(),
      parentObjectId: this.lazyId,
      parentComputeObjectMetadataArgs: this.computeMetadataArgs,
      parentSpanIds: {
        // Late OpenTelemetry setup can replace the ID generator. Resolve the
        // baseline only when a standalone log first needs it.
        rootSpanId:
          current?.rootSpanId ??
          (this.baselineTraceId ??= this.state.idGenerator.getTraceId()),
        parentSpanIds: [],
      },
      spanId: current?.spanParents[0],
      name: "Log",
      spanAttributes: { name: null, type: "log", log_level: level },
      startTime: timestamp,
      event: {
        output: rendered.body,
        metadata: rendered.metadata,
        metrics: { end: timestamp },
      },
    });
    return span.id;
  }

  /**
   * Preserve a native JavaScript template literal and its interpolation values.
   * Format values with JavaScript expressions, such as `${amount.toFixed(2)}`.
   * Pass the result to any application-log severity method.
   *
   * @example
   * logger.info(logger.fmt`User ${userId} paid ${amount.toFixed(2)}`, {
   *   metadata: { source: "checkout" },
   * });
   */
  public fmt(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): ApplicationLogTemplate {
    return formatLogTemplate(strings, values);
  }

  /** Capture a trace-level application log. Does not start a trace. */
  public trace(body: unknown, options?: ApplicationLogOptions): string {
    return this.emitLog(body, "trace", options);
  }

  /** Capture a debug-level application log. Supports {@link Logger.fmt} templates. */
  public debug(body: unknown, options?: ApplicationLogOptions): string {
    return this.emitLog(body, "debug", options);
  }

  /**
   * Capture an info-level application log. Bodies may be any JSON-serializable value.
   * Logs share the active span's IDs, or a baseline trace ID for this logger.
   * Use {@link Logger.fmt} to preserve a native JavaScript template and its values
   * in `braintrust.template` metadata fields.
   * Returns the row ID.
   *
   * @example
   * logger.info(logger.fmt`User ${userId} paid ${amount.toFixed(2)}`, {
   *   metadata: { source: "checkout" },
   * });
   */
  public info(body: unknown, options?: ApplicationLogOptions): string {
    return this.emitLog(body, "info", options);
  }

  /** Capture a warn-level application log. Supports {@link Logger.fmt} templates. */
  public warn(body: unknown, options?: ApplicationLogOptions): string {
    return this.emitLog(body, "warn", options);
  }

  /** Capture an error-level application log. Supports {@link Logger.fmt} templates. */
  public error(body: unknown, options?: ApplicationLogOptions): string {
    return this.emitLog(body, "error", options);
  }

  /** Capture a fatal-level application log. Supports {@link Logger.fmt} templates. */
  public fatal(body: unknown, options?: ApplicationLogOptions): string {
    return this.emitLog(body, "fatal", options);
  }

  /**
   * Create a new toplevel span underneath the logger. The name defaults to "root".
   *
   * See {@link Span.traced} for full details.
   */
  public traced<R>(
    callback: (span: Span) => R,
    args?: StartSpanArgs & SetCurrentArg,
  ): R {
    const { setCurrent, ...argsRest } = args ?? {};
    const span = this.startSpan(argsRest);

    return runCatchFinally(
      () => {
        if (setCurrent ?? true) {
          return withCurrent(span, callback);
        } else {
          return callback(span);
        }
      },
      (error) => {
        logError(span, error);
        throw error;
      },
      () => span.end(),
    );
  }

  /**
   * Lower-level alternative to `traced`. This allows you to start a span yourself, and can be useful in situations
   * where you cannot use callbacks. However, spans started with `startSpan` will not be marked as the "current span",
   * so `currentSpan()` and `traced()` will be no-ops. If you want to mark a span as current, use `traced` instead.
   *
   * See {@link traced} for full details.
   */
  public startSpan(args?: StartSpanArgs): Span {
    this.calledStartSpan = true;
    return this.startSpanImpl(args);
  }

  private startSpanImpl(args?: StartSpanArgs): Span {
    return new SpanImpl({
      [CAPTURE_ATTACHMENTS]: this[CAPTURE_ATTACHMENTS],
      ...args,
      // Sometimes `args` gets passed directly into this function, and it contains an undefined value for `state`.
      // To ensure that we always use this logger's state, we override the `state` argument no matter what.
      state: this.state,
      ...startSpanParentArgs({
        state: this.state,
        parent: args?.parent,
        parentObjectType: this.parentObjectType(),
        parentObjectId: this.lazyId,
        parentComputeObjectMetadataArgs: this.computeMetadataArgs,
        parentSpanIds: args?.parentSpanIds,
        propagatedEvent: args?.propagatedEvent,
      }),
      defaultRootType: SpanTypeAttribute.TASK,
    });
  }

  /**
   * Log feedback to an event. Feedback is used to save feedback scores, set an expected value, or add a comment.
   *
   * @param event
   * @param event.id The id of the event to log feedback for. This is the `id` returned by `log` or accessible as the `id` field of a span.
   * @param event.scores (Optional) a dictionary of numeric values (between 0 and 1) to log. These scores will be merged into the existing scores for the event.
   * @param event.expected (Optional) the ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not.
   * @param event.comment (Optional) an optional comment string to log about the event.
   * @param event.metadata (Optional) a dictionary with additional data about the feedback. If you have a `user_id`, you can log it here and access it in the Braintrust UI. Note, this metadata does not correspond to the main event itself, but rather the audit log attached to the event.
   * @param event.source (Optional) the source of the feedback. Must be one of "external" (default), "app", or "api".
   */
  public logFeedback(event: LogFeedbackFullArgs): void {
    logFeedbackImpl(this.state, this.parentObjectType(), this.lazyId, event);
  }

  /**
   * Update a span in the experiment using its id. It is important that you only update a span once the original span has been fully written and flushed,
   * since otherwise updates to the span may conflict with the original span.
   *
   * @param event The event data to update the span with. Must include `id`. See {@link Experiment.log} for a full list of valid fields.
   */
  public updateSpan(
    event: Omit<Partial<ExperimentEvent>, "id"> &
      Required<Pick<ExperimentEvent, "id">>,
  ): void {
    const { id, root_span_id, span_id, ...eventRest } = event;
    if (!id) {
      throw new Error("Span id is required to update a span");
    }
    updateSpanImpl({
      state: this.state,
      parentObjectType: this.parentObjectType(),
      parentObjectId: this.lazyId,
      id,
      root_span_id,
      span_id,
      event: eventRest,
    });
  }

  /**
   * Return a serialized representation of the logger that can be used to start subspans in other places.
   *
   * See {@link Span.startSpan} for more details.
   */
  public async export(): Promise<string> {
    // Note: it is important that the object id we are checking for
    // `has_computed` is the same as the one we are passing into the span
    // logging functions. So that if the spans actually do get logged, then this
    // `_lazy_id` object specifically will also be marked as computed.
    return new (getSpanComponentsClass())({
      object_type: this.parentObjectType(),
      ...(this.computeMetadataArgs && !this.lazyId.hasSucceeded
        ? { compute_object_metadata_args: this.computeMetadataArgs }
        : { object_id: await this.lazyId.get() }),
    }).toStr();
  }

  /*
   * Flush any pending logs to the server.
   */
  async flush(): Promise<void> {
    return await this.state.bgLogger().flush();
  }

  /**
   * Return the base URL for links (e.g. https://braintrust.dev/app/my-org-name)
   * if we have the info, otherwise return null.
   * Resolution order: state -> linkArgs -> env var
   */
  public _getLinkBaseUrl(): string | null {
    return _getLinkBaseUrl(this.state, this.linkArgs);
  }

  /**
   * Return this logger's Braintrust parent string (`project_id:<id>` or
   * `project_name:<name>`) for the `braintrust.parent` baggage entry, or
   * undefined when it cannot be determined synchronously.
   */
  public _getOtelParent(): string | undefined {
    const id =
      this.computeMetadataArgs?.project_id || this.lazyId.getSync().value;
    if (id) {
      return `project_id:${id}`;
    }
    const name = this.computeMetadataArgs?.project_name;
    if (name) {
      return `project_name:${name}`;
    }
    return undefined;
  }
}

export type Logs3OverflowUpload = {
  method: "PUT" | "POST";
  signedUrl: string;
  headers?: Record<string, string>;
  fields?: Record<string, string>;
  key: string;
};

export const logs3OverflowUploadSchema: z.ZodType<Logs3OverflowUpload> =
  z.object({
    method: z.enum(["PUT", "POST"]),
    signedUrl: z.string().url(),
    headers: z.record(z.string()).optional(),
    fields: z.record(z.string()).optional(),
    key: z.string().min(1),
  });

export type Logs3OverflowInputRow = {
  object_ids: Record<string, unknown>;
  is_delete?: boolean;
  input_row: {
    byte_size: number;
  };
};

type LogItemWithMeta = {
  str: string;
  overflowMeta: Logs3OverflowInputRow;
};

function constructLogs3Data(items: LogItemWithMeta[]) {
  return `{"rows": ${constructJsonArray(items.map((i) => i.str))}, "api_version": 2}`;
}

export function constructLogs3OverflowRequest(key: string): {
  rows: { type: string; key: string };
  api_version: number;
} {
  return {
    rows: {
      type: LOGS3_OVERFLOW_REFERENCE_TYPE,
      key,
    },
    api_version: 2,
  };
}

export function pickLogs3OverflowObjectIds(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const objectIds: Record<string, unknown> = {};
  for (const key of OBJECT_ID_KEYS) {
    if (key in row) {
      objectIds[key] = row[key];
    }
  }
  return objectIds;
}

/**
 * Upload a logs3 overflow payload to the signed URL.
 * This is a standalone function that can be used by both SDK and app code.
 *
 * @param upload - The overflow upload metadata from the API
 * @param payload - The JSON payload string to upload
 * @param fetchFn - Optional custom fetch function (defaults to global fetch)
 */
export async function uploadLogs3OverflowPayload(
  upload: Logs3OverflowUpload,
  payload: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (upload.method === "POST") {
    if (!upload.fields) {
      throw new Error("Missing logs3 overflow upload fields");
    }
    if (typeof FormData === "undefined" || typeof Blob === "undefined") {
      throw new Error("FormData is not available for logs3 overflow upload");
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) {
      form.append(key, value);
    }
    const contentType = upload.fields["Content-Type"] ?? "application/json";
    form.append("file", new Blob([payload], { type: contentType }));
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(upload.headers ?? {})) {
      if (key.toLowerCase() !== "content-type") {
        headers[key] = value;
      }
    }
    const response = await fetchFn(upload.signedUrl, {
      method: "POST" satisfies RequestInit["method"],
      headers,
      body: form,
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `Failed to upload logs3 overflow payload: ${response.status} ${responseText}`,
      );
    }
    return;
  }
  const headers: Record<string, string> = { ...(upload.headers ?? {}) };
  addAzureBlobHeaders(headers, upload.signedUrl);
  const response = await fetchFn(upload.signedUrl, {
    method: "PUT" satisfies RequestInit["method"],
    headers,
    body: payload,
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(
      `Failed to upload logs3 overflow payload: ${response.status} ${responseText}`,
    );
  }
}

function stringifyWithOverflowMeta(item: object): LogItemWithMeta {
  const str = JSON.stringify(item);
  const record = item as Record<string, unknown>;
  return {
    str,
    overflowMeta: {
      object_ids: pickLogs3OverflowObjectIds(record),
      is_delete: record[OBJECT_DELETE_FIELD] === true,
      input_row: {
        byte_size: utf8ByteLength(str),
      },
    },
  };
}

export function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

function now() {
  return new Date().getTime();
}

export interface BackgroundLoggerOpts {
  noExitFlush?: boolean;
  onFlushError?: (error: unknown) => void;
}

const DEFAULT_FLUSH_BACKPRESSURE_BYTES = 10 * 1024 * 1024;
// 10 MB
const DEFAULT_MAX_CONCURRENT_LOG_REQUESTS = 8;

// Read a numeric environment variable. Unset, empty, whitespace-only and
// non-numeric values return undefined so the caller keeps its default, rather
// than being read as 0 (`Number("") === 0`).
function getNumericEnv(name: string): number | undefined {
  const raw = iso.getEnv(name);
  if (raw === undefined || raw === null || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  return isNaN(value) ? undefined : value;
}

// Like the OTel BatchSpanProcessor, wait briefly before flushing so rows
// logged close together share a request and a span's start and end rows can
// merge into one. Rows still waiting on the delay are lost when the process
// exits without `beforeExit` (signals, `process.exit()`).
// Only long-lived Node processes delay by default: serverless and
// scale-to-zero platforms may freeze or throttle the process before a timer
// fires, and browser and edge runtimes have no exit flush.
const DEFAULT_FLUSH_DELAY_MS = 1000;

function isServerlessEnvironment(): boolean {
  return (
    !!iso.getEnv("VERCEL") ||
    !!iso.getEnv("NETLIFY") ||
    !!iso.getEnv("AWS_EXECUTION_ENV")?.startsWith("AWS_Lambda_") ||
    !!iso.getEnv("AWS_LAMBDA_FUNCTION_NAME") ||
    !!iso.getEnv("K_SERVICE") ||
    !!iso.getEnv("FUNCTION_TARGET") ||
    iso.getEnv("GAE_ENV") === "standard" ||
    !!iso.getEnv("FUNCTIONS_WORKER_RUNTIME")
  );
}

function defaultFlushDelayMs(): number {
  return iso.buildType === "node" && !isServerlessEnvironment()
    ? DEFAULT_FLUSH_DELAY_MS
    : 0;
}

interface BackgroundLogger {
  log(items: LazyValue<BackgroundLogEvent>[]): void;
  flush(): Promise<void>;
  pendingFlushBytes(): number;
  flushBackpressureBytes(): number;
  setMaskingFunction(
    maskingFunction: ((value: unknown) => unknown) | null,
  ): void;
}

export class TestBackgroundLogger implements BackgroundLogger {
  private items: LazyValue<BackgroundLogEvent>[][] = [];
  private exportCustomizers: readonly SpanCustomizer[] = [];

  log(items: LazyValue<BackgroundLogEvent>[]): void {
    this.items.push(items);
  }

  setMaskingFunction(
    maskingFunction: ((value: unknown) => unknown) | null,
  ): void {
    this.exportCustomizers = maskingFunction
      ? [createMaskingCustomizer(maskingFunction)]
      : [];
  }

  async flush(): Promise<void> {
    return Promise.resolve();
  }

  pendingFlushBytes(): number {
    return 0;
  }

  flushBackpressureBytes(): number {
    return DEFAULT_FLUSH_BACKPRESSURE_BYTES;
  }

  async drain(): Promise<BackgroundLogEvent[]> {
    const items = this.items;
    this.items = [];

    // get all the values
    const events: BackgroundLogEvent[] = [];
    for (const item of items) {
      for (const event of item) {
        events.push(await event.get());
      }
    }

    let batch = mergeCustomizedSpanRecords(events).flat();

    if (this.exportCustomizers.length) {
      batch = batch.map(
        (item) =>
          customizeSpanExport(
            item as SpanExportData,
            this.exportCustomizers,
          ) as BackgroundLogEvent,
      );
    }

    return batch;
  }
}

const BACKGROUND_LOGGER_BASE_SLEEP_TIME_S = 1.0;

const HTTP_RETRY_BASE_SLEEP_TIME_S = 1.0;

const HTTP_RETRY_JITTER_MS = 200;

export const BTQL_HTTP_RETRIES = 3;

const RETRYABLE_HTTP_STATUS_CODES = new Set([500, 502, 503, 504]);

function isRetryableHTTPError(error: unknown): boolean {
  return (
    !(error instanceof FailedHTTPResponse) ||
    RETRYABLE_HTTP_STATUS_CODES.has(error.status)
  );
}

function formatHTTPError(error: unknown): string {
  if (error instanceof FailedHTTPResponse) {
    return `${error.status} ${error.text}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Request aborted");
}

async function waitForRetry(
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }

  if (signal.aborted) {
    throw getAbortReason(signal);
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(getAbortReason(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

// We should only have one instance of this object per state object in
// 'BraintrustState._bgLogger'. Be careful about spawning multiple
// instances of this class, because concurrent BackgroundLoggers will not log to
// the backend in a deterministic order.
class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.activeCount++;
    }

    try {
      return await callback();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.activeCount--;
      }
    }
  }
}

interface QueuedLogEvent {
  sequence: number;
  event: LazyValue<BackgroundLogEvent>;
}

class HTTPBackgroundLogger implements BackgroundLogger {
  private readonly typedAttachments = new TypedAttachmentProcessor();
  private apiConn: LazyValue<HTTPConnection>;
  private queue: Queue<QueuedLogEvent>;
  private activeFlush: Promise<void> = Promise.resolve();
  private activeFlushResolved = true;
  private onFlushError?: (error: unknown) => void;
  private exportCustomizers: readonly SpanCustomizer[] = [];
  private readonly requestLimiter: ConcurrencyLimiter;
  private lastEnqueuedSequence = 0;
  private completedSequence = 0;
  private cancelFlushTimer: (() => void) | undefined;
  // Enqueue time of the oldest row that no flush has drained yet.
  private pendingSince: number | undefined;
  private readonly exitFlushRegistered: boolean;

  public syncFlush: boolean = false;
  public flushDelayMs: number;
  private maxRequestSizeOverride: number | null = null;
  private _maxRequestSizePromise: Promise<{
    maxRequestSize: number;
    canUseOverflow: boolean;
  }> | null = null;
  public defaultBatchSize: number = 100;
  public numTries: number = 3;
  public queueDropExceedingMaxsize: number = DEFAULT_QUEUE_SIZE;
  public queueDropLoggingPeriod: number = 60;
  public failedPublishPayloadsDir: string | undefined = undefined;
  public allPublishPayloadsDir: string | undefined = undefined;
  private _flushBackpressureBytes: number = DEFAULT_FLUSH_BACKPRESSURE_BYTES;

  private _pendingBytes: number = 0;

  private _disabled = false;
  private automaticAttachmentsDisabled = false;

  private queueDropLoggingState = {
    numDropped: 0,
    lastLoggedTimestamp: 0,
  };

  constructor(apiConn: LazyValue<HTTPConnection>, opts?: BackgroundLoggerOpts) {
    opts = opts ?? {};
    this.apiConn = apiConn;

    const syncFlushEnv = getNumericEnv("BRAINTRUST_SYNC_FLUSH");
    if (syncFlushEnv !== undefined) {
      this.syncFlush = Boolean(syncFlushEnv);
    }

    const defaultBatchSizeEnv = getNumericEnv("BRAINTRUST_DEFAULT_BATCH_SIZE");
    if (defaultBatchSizeEnv !== undefined) {
      this.defaultBatchSize = defaultBatchSizeEnv;
    }

    const flushDelayMsEnv = getNumericEnv("BRAINTRUST_FLUSH_DELAY_MS");
    this.flushDelayMs =
      flushDelayMsEnv !== undefined && flushDelayMsEnv >= 0
        ? flushDelayMsEnv
        : defaultFlushDelayMs();

    const maxRequestSizeEnv = getNumericEnv("BRAINTRUST_MAX_REQUEST_SIZE");
    if (maxRequestSizeEnv !== undefined) {
      this.maxRequestSizeOverride = maxRequestSizeEnv;
    }

    const numTriesEnv = getNumericEnv("BRAINTRUST_NUM_RETRIES");
    if (numTriesEnv !== undefined) {
      this.numTries = numTriesEnv + 1;
    }

    const queueDropExceedingMaxsizeEnv = getNumericEnv(
      "BRAINTRUST_QUEUE_DROP_EXCEEDING_MAXSIZE",
    );

    if (queueDropExceedingMaxsizeEnv !== undefined) {
      this.queueDropExceedingMaxsize = queueDropExceedingMaxsizeEnv;
    }

    this.queue = new Queue(this.queueDropExceedingMaxsize);

    const maxConcurrentLogRequests =
      getNumericEnv("BRAINTRUST_MAX_CONCURRENT_LOG_REQUESTS") ??
      DEFAULT_MAX_CONCURRENT_LOG_REQUESTS;
    if (
      !Number.isInteger(maxConcurrentLogRequests) ||
      maxConcurrentLogRequests < 1
    ) {
      debugLogger.warn(
        `maxConcurrentLogRequests ${maxConcurrentLogRequests} is not a positive integer, using default ${DEFAULT_MAX_CONCURRENT_LOG_REQUESTS}`,
      );
      this.requestLimiter = new ConcurrencyLimiter(
        DEFAULT_MAX_CONCURRENT_LOG_REQUESTS,
      );
    } else {
      this.requestLimiter = new ConcurrencyLimiter(maxConcurrentLogRequests);
    }

    const queueDropLoggingPeriodEnv = getNumericEnv(
      "BRAINTRUST_QUEUE_DROP_LOGGING_PERIOD",
    );
    if (queueDropLoggingPeriodEnv !== undefined) {
      this.queueDropLoggingPeriod = queueDropLoggingPeriodEnv;
    }

    if (iso.getEnv("BRAINTRUST_LOG_FLUSH_CHUNK_SIZE")) {
      debugLogger.warn(
        "BRAINTRUST_LOG_FLUSH_CHUNK_SIZE is deprecated and no longer has any effect. " +
          "Log flushing now sends all items at once and batches them automatically. " +
          "This environment variable will be removed in a future major release.",
      );
    }

    const flushBackpressureBytesEnv = getNumericEnv(
      "BRAINTRUST_FLUSH_BACKPRESSURE_BYTES",
    );
    if (
      flushBackpressureBytesEnv !== undefined &&
      flushBackpressureBytesEnv > 0
    ) {
      this._flushBackpressureBytes = flushBackpressureBytesEnv;
    }

    const failedPublishPayloadsDirEnv = iso.getEnv(
      "BRAINTRUST_FAILED_PUBLISH_PAYLOADS_DIR",
    );
    if (failedPublishPayloadsDirEnv) {
      this.failedPublishPayloadsDir = failedPublishPayloadsDirEnv;
    }

    const allPublishPayloadsDirEnv = iso.getEnv(
      "BRAINTRUST_ALL_PUBLISH_PAYLOADS_DIR",
    );
    if (allPublishPayloadsDirEnv) {
      this.allPublishPayloadsDir = allPublishPayloadsDirEnv;
    }

    // Note that this will not run for explicit termination events, such as
    // calls to `process.exit()` or uncaught exceptions. Thus it is a
    // "best-effort" flush.
    if (!opts.noExitFlush) {
      iso.processOn("beforeExit", async () => {
        await this.flush();
      });
    }
    this.exitFlushRegistered = !opts.noExitFlush;
    this.onFlushError = opts.onFlushError;
  }

  setMaskingFunction(
    maskingFunction: ((value: unknown) => unknown) | null,
  ): void {
    this.exportCustomizers = maskingFunction
      ? [createMaskingCustomizer(maskingFunction)]
      : [];
  }

  pendingFlushBytes(): number {
    return this._pendingBytes;
  }

  flushBackpressureBytes(): number {
    return this._flushBackpressureBytes;
  }

  log(items: LazyValue<BackgroundLogEvent>[]): void {
    if (this._disabled) {
      return;
    }

    const queuedItems = items.map((event) => ({
      sequence: ++this.lastEnqueuedSequence,
      event,
    }));
    const droppedItems = this.queue.push(...queuedItems);
    // Queue limits reject a suffix of newly pushed items, so their sequence
    // numbers can be reused by the next accepted events.
    this.lastEnqueuedSequence -= droppedItems.length;
    this.pendingSince ??= Date.now();

    if (!this.syncFlush) {
      this.scheduleFlush();
    }

    if (droppedItems.length) {
      this.registerDroppedItemCount(droppedItems.length);
      if (this.allPublishPayloadsDir || this.failedPublishPayloadsDir) {
        this.dumpDroppedEvents(droppedItems.map((item) => item.event));
      }
    }
  }

  private getMaxRequestSize(): Promise<{
    maxRequestSize: number;
    canUseOverflow: boolean;
  }> {
    if (!this._maxRequestSizePromise) {
      this._maxRequestSizePromise = (async () => {
        let serverLimit: number | null = null;
        try {
          const conn = await this.apiConn.get();
          const versionInfo = await conn.get_json("version");
          serverLimit =
            z
              .object({ logs3_payload_max_bytes: z.number().nullish() })
              .parse(versionInfo).logs3_payload_max_bytes ?? null;
        } catch (e) {
          debugLogger.warn(
            "Failed to fetch version info for payload limit:",
            e,
          );
        }
        const validServerLimit =
          serverLimit !== null && serverLimit > 0 ? serverLimit : null;
        const canUseOverflow = validServerLimit !== null;
        let maxRequestSize = DEFAULT_MAX_REQUEST_SIZE;
        if (this.maxRequestSizeOverride !== null) {
          maxRequestSize =
            validServerLimit !== null
              ? Math.min(this.maxRequestSizeOverride, validServerLimit)
              : this.maxRequestSizeOverride;
        } else if (validServerLimit !== null) {
          maxRequestSize = validServerLimit;
        }
        return { maxRequestSize, canUseOverflow };
      })();
    }
    return this._maxRequestSizePromise;
  }

  async flush(): Promise<void> {
    const targetSequence = this.lastEnqueuedSequence;

    while (this.completedSequence < targetSequence) {
      this.triggerActiveFlush();
      await this.activeFlush;
    }
  }

  private async flushThrough(
    flushBoundary: number,
    args?: { batchSize?: number },
  ): Promise<void> {
    const batchSize = args?.batchSize ?? this.defaultBatchSize;

    const queuedItems = this.queue.drainWhile(
      (item) => item.sequence <= flushBoundary,
    );
    if (queuedItems.length === 0) {
      return;
    }

    try {
      if (!this._disabled) {
        await this.flushWrappedItemsChunk(
          queuedItems.map((item) => item.event),
          batchSize,
        );
      }
    } catch (error) {
      this.reportFlushError(error);
    } finally {
      this.completedSequence = queuedItems[queuedItems.length - 1].sequence;
    }
  }

  private async flushWrappedItemsChunk(
    wrappedItems: LazyValue<BackgroundLogEvent>[],
    batchSize: number,
  ) {
    if (!wrappedItems.length) {
      return;
    }

    const [allItems, attachments] = await this.unwrapLazyValues(wrappedItems);
    // Decision/extraction media is converted only after customizers/masking. Commit each
    // record's references only after every automatic upload succeeds, so errors
    // retain the customized original payload and never prevent span export.
    for (const group of allItems) {
      for (let i = 0; i < group.length; i++) {
        if ("span_id" in group[i]) {
          group[i] = await this.typedAttachments.process(
            group[i],
            Reflect.get(group[i], CAPTURE_ATTACHMENTS),
          );
        }
      }
    }

    // Upload automatic conversions in the background before serialization so
    // pipeline failures can export inline media. Customizers and masking have
    // already removed any private media; fallback must not resurrect it.
    const originals = new Map<string, unknown>();
    const automatic = attachments.filter((attachment) => {
      if (!automaticAttachmentOriginals.has(attachment)) return false;
      originals.set(
        attachment.reference.key,
        automaticAttachmentOriginals.get(attachment),
      );
      return true;
    });
    for (const attachment of automatic) {
      if (this.automaticAttachmentsDisabled) break;
      try {
        const status = await attachment.upload();
        if (status.upload_status === "error")
          throw new Error("Automatic attachment upload failed");
      } catch {
        this.automaticAttachmentsDisabled = true;
        debugLogger.warn(
          "Automatic attachment uploads disabled after an upload failure; exporting original inline media.",
        );
      }
    }
    if (this.automaticAttachmentsDisabled && automatic.length) {
      for (const group of allItems) {
        for (let i = 0; i < group.length; i++) {
          group[i] = restoreAutomaticAttachments(
            group[i],
            originals,
          ) as BackgroundLogEvent;
        }
      }
    }

    // Failure barriers must be sent in order, in separate requests. Within each
    // group, retain the normal parallel transport batching.
    let chunkBytes = 0;
    const groupsWithMeta = allItems.map((group) =>
      group.map((item) => {
        const withMeta = stringifyWithOverflowMeta(item);
        chunkBytes += withMeta.str.length;
        return withMeta;
      }),
    );
    this._pendingBytes += chunkBytes;

    const maxRequestSizeResult = await this.getMaxRequestSize();
    const results: ({ type: "success" } | { type: "error"; value: unknown })[] =
      [];
    for (const items of groupsWithMeta) {
      // Later groups may depend on rows in a failed group, so stop sending.
      if (results.some((r) => r.type === "error")) break;
      const batches = batchItems({
        items,
        batchMaxNumItems: batchSize,
        batchMaxNumBytes: maxRequestSizeResult.maxRequestSize / 2,
        getByteSize: (item) => item.str.length,
      });
      results.push(
        ...(await Promise.all(
          batches.map((batch) =>
            this.requestLimiter.run(async () => {
              try {
                await this.submitLogsRequest(batch, maxRequestSizeResult);
                return { type: "success" } as const;
              } catch (e) {
                return { type: "error", value: e } as const;
              }
            }),
          ),
        )),
      );
    }
    this._pendingBytes = Math.max(0, this._pendingBytes - chunkBytes);
    const failingResultErrors = results
      .map((r) => (r.type === "success" ? undefined : r.value))
      .filter((r) => r !== undefined);
    if (failingResultErrors.length) {
      throw new AggregateError(
        failingResultErrors,
        `Encountered the following errors while logging:`,
      );
    }

    const attachmentErrors: unknown[] = [];
    // For now, upload attachments serially.
    for (const attachment of attachments) {
      if (automaticAttachmentOriginals.has(attachment)) continue;
      try {
        const result = await attachment.upload();
        if (result.upload_status === "error") {
          throw new Error(result.error_message);
        }
      } catch (error) {
        attachmentErrors.push(error);
      }
    }
    if (attachmentErrors.length === 1) {
      throw attachmentErrors[0];
    } else if (attachmentErrors.length > 1) {
      throw new AggregateError(
        attachmentErrors,
        `Encountered the following errors while uploading attachments:`,
      );
    }
  }

  private async unwrapLazyValues(
    wrappedItems: LazyValue<BackgroundLogEvent>[],
  ): Promise<[BackgroundLogEvent[][], Attachment[]]> {
    for (let i = 0; i < this.numTries; ++i) {
      try {
        const items = await Promise.all(wrappedItems.map((x) => x.get()));

        // TODO(kevin): `extractAttachments` should ideally come after
        // `mergeRowBatch`, since merge-overwriting could result in some
        // attachments that no longer need to be uploaded. This would require
        // modifying the merge logic to treat the Attachment object as a "leaf"
        // rather than attempting to merge the keys of the Attachment.
        let attachments: Attachment[] = [];
        items.forEach((item) => extractAttachments(item, attachments));

        let mergedItems = mergeCustomizedSpanRecords(items);

        if (this.exportCustomizers.length) {
          mergedItems = mergedItems.map((group) =>
            group.map((item) => {
              const customized = customizeSpanExport(
                item as SpanExportData,
                this.exportCustomizers,
              ) as BackgroundLogEvent;
              Object.defineProperty(customized, CAPTURE_ATTACHMENTS, {
                value: Reflect.get(item, CAPTURE_ATTACHMENTS),
                configurable: true,
              });
              return customized;
            }),
          );
          // Customizers may strip or replace attachment references; don't upload
          // content that is no longer referenced by any exported record.
          const referencedKeys = new Set<string>();
          mergedItems.forEach((group) =>
            group.forEach((item) =>
              collectAttachmentReferenceKeys(item, referencedKeys),
            ),
          );
          attachments = attachments.filter(
            (attachment) =>
              attachment.reference.type !== BRAINTRUST_ATTACHMENT ||
              referencedKeys.has(attachment.reference.key),
          );
        }

        return [mergedItems, attachments];
      } catch (e) {
        let errmsg = "Encountered error when constructing records to flush";
        const isRetrying = i + 1 < this.numTries;
        if (isRetrying) {
          errmsg += ". Retrying";
        }

        debugLogger.warn(errmsg);
        if (!isRetrying) {
          debugLogger.warn(
            `Failed to construct log records to flush after ${this.numTries} attempts. Dropping batch`,
          );
          throw e;
        } else {
          debugLogger.warn(e);
          const sleepTimeS = BACKGROUND_LOGGER_BASE_SLEEP_TIME_S * 2 ** i;
          debugLogger.info(`Sleeping for ${sleepTimeS}s`);
          await new Promise((resolve) =>
            setTimeout(resolve, sleepTimeS * 1000),
          );
        }
      }
    }
    throw new Error("Impossible");
  }

  private async requestLogs3OverflowUpload(
    conn: HTTPConnection,
    args: { rows: Logs3OverflowInputRow[]; sizeBytes: number },
  ): Promise<Logs3OverflowUpload> {
    let response: unknown;
    try {
      response = await conn.post_json("logs3/overflow", {
        content_type: "application/json",
        size_bytes: args.sizeBytes,
        rows: args.rows,
      });
    } catch (error) {
      const errorStr = JSON.stringify(error);
      throw new Error(
        `Failed to request logs3 overflow upload URL: ${errorStr}`,
      );
    }

    try {
      return logs3OverflowUploadSchema.parse(response);
    } catch (error) {
      if (error instanceof ZodError) {
        const errorStr = JSON.stringify(error.flatten());
        throw new Error(`Invalid response from API server: ${errorStr}`);
      }
      throw error;
    }
  }

  private async _uploadLogs3OverflowPayload(
    conn: HTTPConnection,
    upload: Logs3OverflowUpload,
    payload: string,
  ): Promise<void> {
    // Delegate to the public function, using the connection's fetch
    await uploadLogs3OverflowPayload(upload, payload, conn.fetch.bind(conn));
  }

  private async submitLogsRequest(
    items: LogItemWithMeta[],
    {
      maxRequestSize,
      canUseOverflow,
    }: { maxRequestSize: number; canUseOverflow: boolean },
  ): Promise<void> {
    const conn = await this.apiConn.get();
    const dataStr = constructLogs3Data(items);
    const payloadBytes = utf8ByteLength(dataStr);
    const useOverflow = canUseOverflow && payloadBytes > maxRequestSize;
    if (this.allPublishPayloadsDir) {
      await HTTPBackgroundLogger.writePayloadToDir({
        payloadDir: this.allPublishPayloadsDir,
        payload: dataStr,
      });
    }

    let overflowUpload: Logs3OverflowUpload | null = null;
    const overflowRows = useOverflow
      ? items.map((item) => item.overflowMeta)
      : null;

    for (let i = 0; i < this.numTries; i++) {
      const startTime = now();
      let error: unknown = undefined;
      try {
        if (overflowRows) {
          if (!overflowUpload) {
            const currentUpload = await this.requestLogs3OverflowUpload(conn, {
              rows: overflowRows,
              sizeBytes: payloadBytes,
            });
            await this._uploadLogs3OverflowPayload(
              conn,
              currentUpload,
              dataStr,
            );
            overflowUpload = currentUpload;
          }
          await conn.post_json(
            "logs3",
            constructLogs3OverflowRequest(overflowUpload.key),
          );
        } else {
          await conn.post_json("logs3", dataStr);
        }
      } catch (e) {
        error = e;
      }
      if (error === undefined) {
        return;
      }

      const isRetrying = i + 1 < this.numTries;
      const retryingText = isRetrying ? "" : " Retrying";
      const errorText = (() => {
        if (error instanceof FailedHTTPResponse) {
          return `${error.status} (${error.text}): ${error.data}`;
        } else {
          return `${error}`;
        }
      })();
      const errMsg = `log request failed. Elapsed time: ${
        (now() - startTime) / 1000
      } seconds. Payload size: ${
        payloadBytes
      }.${retryingText}\nError: ${errorText}`;

      if (!isRetrying && this.failedPublishPayloadsDir) {
        await HTTPBackgroundLogger.writePayloadToDir({
          payloadDir: this.failedPublishPayloadsDir,
          payload: dataStr,
        });
        this.logFailedPayloadsDir();
      }

      if (!isRetrying) {
        debugLogger.warn(
          `log request failed after ${this.numTries} retries. Dropping batch`,
        );
        throw new Error(errMsg);
      } else {
        debugLogger.warn(errMsg);
        if (isRetrying) {
          const sleepTimeS = BACKGROUND_LOGGER_BASE_SLEEP_TIME_S * 2 ** i;
          debugLogger.info(`Sleeping for ${sleepTimeS}s`);
          await new Promise((resolve) =>
            setTimeout(resolve, sleepTimeS * 1000),
          );
        }
      }
    }
  }

  private registerDroppedItemCount(numItems: number) {
    if (numItems <= 0) {
      return;
    }
    this.queueDropLoggingState.numDropped += numItems;
    const timeNow = getCurrentUnixTimestamp();
    if (
      timeNow - this.queueDropLoggingState.lastLoggedTimestamp >
      this.queueDropLoggingPeriod
    ) {
      debugLogger.warn(
        `Dropped ${this.queueDropLoggingState.numDropped} elements due to full queue`,
      );
      if (this.failedPublishPayloadsDir) {
        this.logFailedPayloadsDir();
      }
      this.queueDropLoggingState.numDropped = 0;
      this.queueDropLoggingState.lastLoggedTimestamp = timeNow;
    }
  }

  private async dumpDroppedEvents(
    wrappedItems: LazyValue<BackgroundLogEvent>[],
  ) {
    const publishPayloadsDir = [
      this.allPublishPayloadsDir,
      this.failedPublishPayloadsDir,
    ].reduce((acc, x) => (x ? acc.concat([x]) : acc), new Array<string>());
    if (!(wrappedItems.length && publishPayloadsDir.length)) {
      return;
    }
    try {
      const [allItems, allAttachments] =
        await this.unwrapLazyValues(wrappedItems);

      const dataStr = constructLogs3Data(
        allItems.flatMap((group) =>
          group.map((x) => stringifyWithOverflowMeta(x)),
        ),
      );
      const attachmentStr = JSON.stringify(
        allAttachments.map((a) => a.debugInfo()),
      );

      const payload = `{"data": ${dataStr}, "attachments": ${attachmentStr}}\n`;

      for (const payloadDir of publishPayloadsDir) {
        await HTTPBackgroundLogger.writePayloadToDir({ payloadDir, payload });
      }
    } catch (e) {
      debugLogger.error(e);
    }
  }

  private static async writePayloadToDir({
    payloadDir,
    payload,
  }: {
    payloadDir: string;
    payload: string;
  }) {
    if (!(iso.pathJoin && iso.mkdir && iso.writeFile)) {
      debugLogger.warn(
        "Cannot dump payloads: filesystem-operations not supported on this platform",
      );
      return;
    }
    const payloadFile = iso.pathJoin(
      payloadDir,
      `payload_${getCurrentUnixTimestamp()}_${uuidv4().slice(0, 8)}.json`,
    );
    try {
      await iso.mkdir(payloadDir, { recursive: true });
      await iso.writeFile(payloadFile, payload);
    } catch (e) {
      debugLogger.error(
        `Failed to write failed payload to output file ${payloadFile}:\n`,
        e,
      );
    }
  }

  // Flush once the oldest pending row has waited `flushDelayMs`, or right away
  // once a full batch of `defaultBatchSize` rows is queued. An active flush
  // reschedules when it finishes, so only one is ever in flight.
  private scheduleFlush() {
    const queueLength = this.queue.length();
    if (queueLength === 0) {
      return;
    }
    if (queueLength >= this.defaultBatchSize) {
      // No-op while a flush is in flight; it reschedules when it finishes.
      this.triggerActiveFlush();
      return;
    }
    if (!this.activeFlushResolved || this.cancelFlushTimer !== undefined) {
      return;
    }

    const now = Date.now();
    const delay = this.pendingSince! + this.flushDelayMs - now;
    if (delay <= 0) {
      this.triggerActiveFlush();
      return;
    }

    let resolveTimer!: () => void;
    const timerDone = new Promise<void>((resolve) => {
      resolveTimer = resolve;
    });
    const timer = setTimeout(() => {
      this.cancelFlushTimer?.();
      this.triggerActiveFlush();
    }, delay);
    this.cancelFlushTimer = () => {
      clearTimeout(timer);
      this.cancelFlushTimer = undefined;
      resolveTimer();
    };
    // With an exit flush registered, a pending timer must not keep the
    // process alive: `beforeExit` flushes whatever is still queued.
    if (this.exitFlushRegistered) {
      (timer as { unref?: () => void }).unref?.();
    }
    this.registerWaitUntil(timerDone);
  }

  private registerWaitUntil(promise: Promise<void>) {
    try {
      waitUntil(promise);
    } catch (error) {
      debugLogger.error("Failed to register background flush", error);
    }
  }

  private triggerActiveFlush() {
    if (this.activeFlushResolved) {
      const flushBoundary = this.lastEnqueuedSequence;
      if (flushBoundary <= this.completedSequence) {
        return;
      }

      // This flush drains everything queued, which supersedes any timer.
      this.cancelFlushTimer?.();
      this.pendingSince = undefined;
      this.activeFlushResolved = false;
      this.activeFlush = (async () => {
        try {
          await this.flushThrough(flushBoundary);
        } catch (err) {
          this.reportFlushError(err);
        } finally {
          this.activeFlushResolved = true;
          if (!this.syncFlush) {
            this.scheduleFlush();
          }
        }
      })();
      this.registerWaitUntil(this.activeFlush);
    }
  }

  private reportFlushError(error: unknown) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    for (const currentError of errors) {
      try {
        this.onFlushError?.(currentError);
      } catch (callbackError) {
        debugLogger.error("Error in onFlushError callback", callbackError);
      }
    }
  }

  private logFailedPayloadsDir() {
    debugLogger.warn(
      `Logging failed payloads to ${this.failedPublishPayloadsDir}`,
    );
  }

  // Should only be called by BraintrustState.
  public internalReplaceApiConn(apiConn: HTTPConnection): void {
    this.apiConn = new LazyValue(async () => apiConn);
  }

  public disable(): void {
    this._disabled = true;
    this.triggerActiveFlush();
  }

  public enforceQueueSizeLimit(enforce: boolean): void {
    this.queue.enforceQueueSizeLimit(enforce);
  }
}

declare global {
  // Set by the bt eval runner when CLI-controlled BTQL should be pushed down
  // into dataset-backed evals.
  // eslint-disable-next-line no-var
  var __bt_eval_internal_btql: Record<string, unknown> | undefined;
}

// Note: the argument names *must* serialize the same way as the argument names
// for the corresponding python function, because this function may be invoked
// from arguments serialized elsewhere.
async function computeLoggerMetadata(
  state: BraintrustState,
  { project_name, project_id, project_group_name }: ProjectMetadataArgs,
) {
  await state.login({});
  const org_id = state.orgId!;
  if (!isEmpty(project_id) && !isEmpty(project_name)) {
    return {
      org_id,
      project: { id: project_id, name: project_name, fullInfo: {} },
    };
  }

  const groupName = project_group_name || undefined;
  const cache = state.projectMetadataCache;
  const key = JSON.stringify([
    state.appUrl,
    org_id,
    state.loginToken,
    isEmpty(project_id)
      ? ["name", project_name || GLOBAL_PROJECT, groupName]
      : ["id", project_id],
  ]);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return structuredClone(await cached.promise);
  }

  const conn = state.appConn();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const entry = {
    // The lookup timeout bounds pending requests; the cache TTL starts on success.
    expiresAt: Infinity,
    promise: Promise.race([
      (async (): Promise<OrgProjectMetadata> => {
        if (isEmpty(project_id)) {
          const response = await conn.post_json(
            "api/project/register",
            {
              project_name: project_name || GLOBAL_PROJECT,
              org_id,
              project_group_name: groupName,
            },
            controller.signal,
          );
          return {
            org_id,
            project: {
              id: response.project.id,
              name: response.project.name,
              fullInfo: response.project,
            },
          };
        }
        const response = await conn.get_json(
          "api/project",
          { id: project_id },
          0,
          controller.signal,
        );
        return {
          org_id,
          project: {
            id: project_id,
            name: response.name,
            fullInfo: response.project,
          },
        };
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(
            "Braintrust project lookup timed out after 30 seconds.",
          );
          reject(error);
          controller.abort(error);
        }, PROJECT_LOOKUP_TIMEOUT_MS);
      }),
    ]),
  };
  cache.set(key, entry);
  try {
    const metadata = await entry.promise;
    entry.expiresAt = Date.now() + PROJECT_CACHE_TTL_MS;
    return structuredClone(metadata);
  } catch (error) {
    if (cache.get(key) === entry) {
      cache.delete(key);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export type InitLoggerOptions = FullLoginOptions & {
  /**
   * Automatically capture inline media as attachments in instrumentation. Explicit booleans override
   * BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS (1 or true); capture is otherwise disabled.
   * With setCurrent: false, this logger and its child spans have an independent policy
   * and an omitted option uses the environment, not the global logger's setting.
   * Current loggers also update the state's default when this option is supplied;
   * omitting it preserves that default. Explicitly logged attachments are unaffected.
   */
  autoCaptureAttachments?: boolean;
  projectName?: string;
  projectId?: string;
  _createInProjectGroup?: string;
  environment?: SpanOriginEnvironment;
  setCurrent?: boolean;
  state?: BraintrustState;
};

/**
 * Create a new logger in a specified project. If the project does not exist, it will be created.
 *
 * @param options Additional options for configuring init().
 * @param options.projectName The name of the project to log into. If unspecified, will default to the Global project.
 * @param options.projectId The id of the project to log into. This takes precedence over projectName if specified.
 * @param options._createInProjectGroup Experimental: the name of an existing project group to create the project in. Existing projects must already belong to the group, otherwise registration fails with a 409. Membership is re-checked on each fresh project lookup, so moving the project out of the group makes new loggers fail with a 409. Ignored when projectId is provided.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. In Node.js,
 * if that is unset, will try the nearest `.env.braintrust` file in the current working directory or parent directories. If no API key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @param options.forceLogin Login again, even if you have already logged in (by default, the logger will not login if you are already logged in)
 * @param options.debugLogLevel Enables internal Braintrust SDK troubleshooting output. Use `"error"`, `"warn"`, `"info"`, or `"debug"` to choose an explicit level, or `false` to explicitly disable it. If omitted, the SDK stays silent unless `BRAINTRUST_DEBUG_LOG_LEVEL` is set.
 * @param setCurrent If true (the default), set the global current-experiment to the newly-created one.
 * @returns The newly created Logger.
 */
export function initLogger(options: Readonly<InitLoggerOptions> = {}): Logger {
  const {
    projectName,
    projectId,
    _createInProjectGroup,
    appUrl,
    apiKey,
    orgName,
    forceLogin,
    debugLogLevel,
    environment,
    fetch,
    state: stateArg,
  } = options || {};

  const computeMetadataArgs = {
    project_name: projectName,
    project_id: projectId,
    project_group_name: _createInProjectGroup,
  };

  const linkArgs = {
    org_name: orgName,
    app_url: appUrl,
  };

  const state = stateArg ?? _internalGetGlobalState();
  state._internalSetTraceContextSigningSecret(apiKey);
  state.setDebugLogLevel(debugLogLevel);
  state.spanOriginEnvironment = detectSpanOriginEnvironment(environment);

  // Enable queue size limit enforcement for initLogger() calls
  // This ensures production observability doesn't OOM customer processes
  state.enforceQueueSizeLimit(true);
  const lazyMetadata: LazyValue<OrgProjectMetadata> = new LazyValue(
    async () => {
      // Otherwise actually log in.
      await state.login({
        orgName,
        apiKey,
        appUrl,
        forceLogin,
        fetch,
      });
      return computeLoggerMetadata(state, computeMetadataArgs);
    },
  );

  const setCurrent = options.setCurrent ?? true;
  if (setCurrent && options.autoCaptureAttachments !== undefined) {
    state.autoCaptureAttachments = options.autoCaptureAttachments;
  }
  const ret = new Logger(state, lazyMetadata, {
    autoCaptureAttachments:
      options.autoCaptureAttachments ??
      (setCurrent ? state.autoCaptureAttachments : undefined),
    computeMetadataArgs,
    linkArgs,
  });
  if (setCurrent) {
    state.currentLogger = ret;
  }
  return ret;
}

/**
 * Options for logging in to Braintrust.
 */
export interface LoginOptions {
  /**
   * The URL of the Braintrust App. Defaults to https://www.braintrust.dev. You should not need
   * to change this unless you are doing the "Full" deployment.
   */
  appUrl?: string;
  /**
   * The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. In Node.js, if that is unset, will try the nearest `.env.braintrust` file in the current working directory or parent directories.
   */
  apiKey?: string;
  /**
   * The name of a specific organization to connect to. Since API keys are scoped to organizations, this parameter is usually
   * unnecessary unless you are logging in with a JWT.
   */
  orgName?: string;
  /**
   * A custom fetch implementation to use.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * By default, the SDK installs an event handler that flushes pending writes on the `beforeExit` event.
   * If true, this event handler will _not_ be installed.
   */
  noExitFlush?: boolean;
  /**
   * Calls this function if there's an error in the background flusher.
   */
  onFlushError?: (error: unknown) => void;
  /**
   * If true, disables the local span cache used to optimize scorer access
   * to trace data. When disabled, scorers will always fetch spans from the
   * server. Defaults to false.
   */
  disableSpanCache?: boolean;
  /**
   * Controls internal Braintrust SDK troubleshooting output.
   *
   * Use `"error"`, `"warn"`, `"info"`, or `"debug"` to control how much
   * internal SDK troubleshooting output is emitted. Use `false` to explicitly
   * disable this output.
   *
   * When omitted, the SDK remains silent unless
   * `BRAINTRUST_DEBUG_LOG_LEVEL` is set to `"error"`, `"warn"`, `"info"`, or
   * `"debug"`. This option only affects local console output; it does not
   * change what data is logged to Braintrust.
   */
  debugLogLevel?: DebugLogLevel | false;
}

export type FullLoginOptions = LoginOptions & {
  forceLogin?: boolean;
};

/**
 * Set a global masking function that will be applied to all logged data before sending to Braintrust.
 * The masking function will be applied after records are merged but before they are sent to the backend.
 * Internally, masking is a state-local export customizer that runs after any
 * span customizers and also covers non-span records such as dataset rows and feedback.
 *
 * @param maskingFunction A function that takes a JSON-serializable object and returns a masked version.
 *                        Set to null to disable masking.
 */
export function setMaskingFunction(
  maskingFunction: ((value: unknown) => unknown) | null,
): void {
  _internalGetGlobalState().setMaskingFunction(maskingFunction);
}

/**
 * Log into Braintrust. This will prompt you for your API token, which you can find at
 * https://www.braintrust.dev/app/token. This method is called automatically by `init()`.
 *
 * @param options Options for configuring login().
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. In Node.js,
 * if that is unset, will try the nearest `.env.braintrust` file in the current working directory or parent directories. If no API key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @param options.forceLogin Login again, even if you have already logged in (by default, this function will exit quickly if you have already logged in)
 */
export async function login(
  options: LoginOptions & { forceLogin?: boolean } = {},
): Promise<BraintrustState> {
  const { forceLogin = false } = options || {};

  if (!_internalGetGlobalState()) {
    _internalSetInitialState();
  }

  const state = _internalGetGlobalState();
  state.setDebugLogLevel(options.debugLogLevel);
  if (state.loggedIn && !forceLogin) {
    // We have already logged in. If any provided login inputs disagree with our
    // existing settings, raise an Exception warning the user to try again with
    // `forceLogin: true`.
    function checkUpdatedParam(
      varname: string,
      arg: string | undefined,
      orig: string | null,
    ) {
      if (!isEmpty(arg) && !isEmpty(orig) && arg !== orig) {
        throw new Error(
          `Re-logging in with different ${varname} (${arg}) than original (${orig}). To force re-login, pass \`forceLogin: true\``,
        );
      }
    }
    checkUpdatedParam("appUrl", options.appUrl, state.appUrl);
    checkUpdatedParam(
      "apiKey",
      options.apiKey
        ? HTTPConnection.sanitize_token(options.apiKey)
        : undefined,
      state.loginToken,
    );
    checkUpdatedParam("orgName", options.orgName, state.orgName);
    return state;
  }

  await state.login(options);
  return state;
}

async function loginToLoaderRequestState({
  appUrl,
  apiKey,
  orgName,
  fetch,
}: Required<Pick<LoginOptions, "appUrl" | "apiKey" | "fetch">> &
  Pick<LoginOptions, "orgName">): Promise<LoaderRequestState> {
  let orgId: string;
  let apiUrl: string;

  if (apiKey === TEST_API_KEY) {
    orgId = "test-org-id";
    apiUrl = "https://braintrust.dev/fake-api-url";
  } else {
    let loginResponse: Response;
    try {
      loginResponse = await fetch(_urljoin(appUrl, `/api/apikey/login`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch (error) {
      throw new HTTPTransportError(error);
    }

    const info = await readJSONResponse(
      await checkResponse(loginResponse),
      true,
    );
    const org = selectLoginOrg(info.org_info, orgName);
    orgId = org.id;
    apiUrl = iso.getEnv("BRAINTRUST_API_URL") || org.api_url;
    if (!apiUrl) {
      throw new Error(
        orgName
          ? `Unable to log into organization '${orgName}'. Are you sure this credential is scoped to the organization?`
          : "Unable to log into any organization with the provided credential.",
      );
    }
  }

  const apiConnection = new HTTPConnection(apiUrl, fetch, true);
  apiConnection.set_token(apiKey);
  apiConnection.make_long_lived();
  return {
    appUrl,
    orgId,
    apiConn: () => apiConnection,
  };
}

export async function loginToState(
  options: LoginOptions = {},
): Promise<BraintrustState> {
  const {
    appUrl = iso.getEnv("BRAINTRUST_APP_URL") || "https://www.braintrust.dev",
    apiKey: apiKeyArg,
    orgName = iso.getEnv("BRAINTRUST_ORG_NAME"),
    fetch = globalThis.fetch,
  } = options || {};

  const apiKey =
    apiKeyArg !== undefined ? apiKeyArg : await iso.getBraintrustApiKey();
  const appPublicUrl = iso.getEnv("BRAINTRUST_APP_PUBLIC_URL") || appUrl;

  const state = new BraintrustState(options);
  state.resetLoginInfo();

  state.appUrl = appUrl;
  state.appPublicUrl = appPublicUrl;

  let conn = null;

  if (!apiKey) {
    throw new Error(
      "Please specify an api key (e.g. by setting BRAINTRUST_API_KEY).",
    );
  } else if (apiKey === TEST_API_KEY) {
    // This is a weird hook that lets us skip logging in and mocking out the org info.
    const testOrgInfo = [
      {
        id: "test-org-id",
        name: "test-org-name",
        api_url: "https://braintrust.dev/fake-api-url",
      },
    ];
    state.loggedIn = true;
    state.loginToken = TEST_API_KEY;
    _saveOrgInfo(state, testOrgInfo, testOrgInfo[0].name);
    return state;
  } else {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let info;
    try {
      // Bound both headers and body reads, including custom fetches that ignore
      // cancellation, so a stalled request cannot block subsequent logins.
      info = await Promise.race([
        (async () => {
          const response = await fetch(_urljoin(appUrl, `/api/apikey/login`), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            signal: controller.signal,
          });
          return readJSONResponse(await checkResponse(response));
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error(
              "Braintrust login timed out after 30 seconds.",
            );
            reject(error);
            controller.abort(error);
          }, LOGIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }

    _saveOrgInfo(state, info.org_info, orgName);
    if (!state.apiUrl) {
      if (orgName) {
        throw new Error(
          `Unable to log into organization '${orgName}'. Are you sure this credential is scoped to the organization?`,
        );
      } else {
        throw new Error(
          "Unable to log into any organization with the provided credential.",
        );
      }
    }

    conn = state.apiConn();
    conn.set_token(apiKey);

    if (!conn) {
      throw new Error("Conn should be set at this point (a bug)");
    }

    conn.make_long_lived();

    // Set the same token in the API
    state.appConn().set_token(apiKey);
    if (state.proxyUrl) {
      state.proxyConn().set_token(apiKey);
    }
    state.loginToken = conn.token;
    state.loggedIn = true;

    // Replace the global logger's apiConn with this one.
    state.loginReplaceApiConn(conn);
  }

  return state;
}

// XXX We should remove these global functions now
/**
 * Log a single event to the current experiment. The event will be batched and uploaded behind the scenes.
 *
 * @param event The event to log. See {@link Experiment.log} for full details.
 * @returns The `id` of the logged event.
 */
export function log(event: ExperimentLogFullArgs): string {
  debugLogger.warn(
    "braintrust.log is deprecated and will be removed in a future version of braintrust. Use `experiment.log` instead.",
  );
  const e = currentExperiment();
  if (!e) {
    throw new Error("Not initialized. Please call init() first");
  }
  return e.log(event);
}

/**
 * Summarize the current experiment, including the scores (compared to the closest reference experiment) and metadata.
 *
 * @param options Options for summarizing the experiment.
 * @param options.summarizeScores Whether to summarize the scores. If False, only the metadata will be returned.
 * @param options.comparisonExperimentId The experiment to compare against. If None, the most recent experiment on the origin's main branch will be used.
 * @returns A summary of the experiment, including the scores (compared to the closest reference experiment) and metadata.
 */
export async function summarize(
  options: {
    readonly summarizeScores?: boolean;
    readonly comparisonExperimentId?: string;
  } = {},
): Promise<ExperimentSummary> {
  debugLogger.warn(
    "braintrust.summarize is deprecated and will be removed in a future version of braintrust. Use `experiment.summarize` instead.",
  );
  const e = currentExperiment();
  if (!e) {
    throw new Error("Not initialized. Please call init() first");
  }
  return await e.summarize(options);
}

type OptionalStateArg = {
  state?: BraintrustState;
};

/**
 * Returns the currently-active experiment (set by {@link init}). Returns undefined if no current experiment has been set.
 */
export function currentExperiment(
  options?: OptionalStateArg,
): Experiment | undefined {
  const state = options?.state ?? _internalGetGlobalState();
  return state.currentExperiment;
}

/**
 * Returns the currently-active logger (set by {@link initLogger}). Returns undefined if no current logger has been set.
 */
export function currentLogger(options?: OptionalStateArg): Logger | undefined {
  const state = options?.state ?? _internalGetGlobalState();
  return state.currentLogger;
}

/**
 * Return the currently-active span for logging (set by one of the `traced` methods). If there is no active span, returns a no-op span object, which supports the same interface as spans but does no logging.
 *
 * See {@link Span} for full details.
 */
export function currentSpan(options?: OptionalStateArg): Span {
  const state = options?.state ?? _internalGetGlobalState();
  return state.contextManager.getCurrentSpan() ?? NOOP_SPAN;
}

/**
 * Resolve the parent object and any forwarded W3C state in a single pass.
 *
 * Same precedence as {@link getSpanParentObject}, but also returns the W3C state
 * (tracestate + raw traceparent flags) recovered while normalizing the `parent`
 * argument, so callers don't have to re-run `normalizeParent` (which would
 * re-parse baggage and re-resolve the active logger/experiment, potentially
 * disagreeing if state changed between calls). The state is only meaningful when
 * a parent slug was resolved; otherwise it is undefined.
 */
function getSpanParentObjectAndPropagatedState(
  options?: OptionalStateArg & { parent?: string | PropagationContext },
): {
  parentObject:
    | SpanComponentsV3
    | SpanComponentsV4
    | Span
    | Experiment
    | Logger;
  propagatedState: PropagatedState | undefined;
} {
  const state = options?.state ?? _internalGetGlobalState();

  const parentSpan = currentSpan({ state });
  if (!Object.is(parentSpan, NOOP_SPAN)) {
    return { parentObject: parentSpan, propagatedState: undefined };
  }

  const parent = options?.parent ?? state.currentParent.getStore();
  const { parentSlug, propagatedState } = normalizeParent(parent, state);
  if (parentSlug) {
    return {
      parentObject: SpanComponentsV4.fromStr(parentSlug),
      propagatedState,
    };
  }

  const experiment = state.currentExperiment;
  if (experiment) {
    return { parentObject: experiment, propagatedState: undefined };
  }
  const logger = state.currentLogger;
  if (logger) {
    return { parentObject: logger, propagatedState: undefined };
  }
  return { parentObject: NOOP_SPAN, propagatedState: undefined };
}

/**
 * Mainly for internal use. Return the parent object for starting a span in a global context.
 * Applies precedence: current span > propagated parent > experiment > logger.
 *
 * `parent` may be an exported slug string or an opaque W3C trace-context (from
 * {@link extractTraceContextFromHeaders}).
 */
export function getSpanParentObject(
  options?: OptionalStateArg & { parent?: string | PropagationContext },
): SpanComponentsV3 | SpanComponentsV4 | Span | Experiment | Logger {
  return getSpanParentObjectAndPropagatedState(options).parentObject;
}

/** @internal */
export function _internalExportParentSynchronously(
  parent: ReturnType<typeof getSpanParentObject>,
): string | undefined {
  if ("toStr" in parent) {
    return parent.toStr();
  }

  if ("getParentInfo" in parent) {
    const parentInfo = parent.getParentInfo();
    if (!parentInfo) {
      return undefined;
    }
    const objectId = parentInfo.objectId.getSync().value;
    if (!objectId && !parentInfo.computeObjectMetadataArgs) {
      return undefined;
    }
    return new SpanComponentsV4({
      object_type: parentInfo.objectType,
      ...(objectId
        ? { object_id: objectId }
        : {
            compute_object_metadata_args:
              parentInfo.computeObjectMetadataArgs ?? {},
          }),
      row_id: parent.id,
      root_span_id: parent.rootSpanId,
      span_id: parent.spanId,
    }).toStr();
  }

  const components = braintrustParentToComponents(parent._getOtelParent());
  if (!components) {
    return undefined;
  }
  return new SpanComponentsV4({
    object_type: components.objectType,
    ...(components.objectId
      ? { object_id: components.objectId }
      : { compute_object_metadata_args: components.computeArgs ?? {} }),
  }).toStr();
}

/**
 * Return the Braintrust parent string for the current logger/experiment, if any.
 *
 * Used as the fallback Braintrust parent on receive, when an inbound request
 * carries trace identity (`traceparent`) but no `braintrust.parent` baggage.
 */
function currentBraintrustParent(state?: BraintrustState): string | undefined {
  const resolvedState = state ?? _internalGetGlobalState();

  const experiment = currentExperiment({ state: resolvedState });
  if (experiment) {
    try {
      return experiment._getOtelParent() ?? undefined;
    } catch {
      return undefined;
    }
  }

  const logger = currentLogger({ state: resolvedState });
  if (logger) {
    try {
      return logger._getOtelParent() ?? undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

interface BraintrustParentComponents {
  objectType: SpanObjectTypeV3;
  objectId: string | undefined;
  computeArgs: Record<string, any> | undefined;
}

/**
 * Parse a `braintrust.parent` string into object type / id / compute args.
 *
 * Accepts `project_id:<id>`, `project_name:<name>`, or `experiment_id:<id>`.
 * Returns undefined if the value is empty or malformed.
 */
function braintrustParentToComponents(
  braintrustParent: string | undefined | null,
): BraintrustParentComponents | undefined {
  if (!braintrustParent) {
    return undefined;
  }
  if (braintrustParent.startsWith("project_id:")) {
    const objectId = braintrustParent.slice("project_id:".length);
    return objectId
      ? {
          objectType: SpanObjectTypeV3.PROJECT_LOGS,
          objectId,
          computeArgs: undefined,
        }
      : undefined;
  }
  if (braintrustParent.startsWith("project_name:")) {
    const name = braintrustParent.slice("project_name:".length);
    return name
      ? {
          objectType: SpanObjectTypeV3.PROJECT_LOGS,
          objectId: undefined,
          computeArgs: { project_name: name },
        }
      : undefined;
  }
  if (braintrustParent.startsWith("experiment_id:")) {
    const objectId = braintrustParent.slice("experiment_id:".length);
    return objectId
      ? {
          objectType: SpanObjectTypeV3.EXPERIMENT,
          objectId,
          computeArgs: undefined,
        }
      : undefined;
  }
  return undefined;
}

/**
 * Set a W3C trace-context header on a carrier, sending the lowercase name.
 *
 * Per the W3C Trace Context spec (§3.2.1 / §3.3.1), vendors SHOULD send these
 * header names in lowercase. `name` is always the canonical lowercase key. A
 * plain object carrier is case-sensitive, so any pre-existing case-variant (e.g.
 * `Baggage` from a framework that title-cases headers) must be removed first,
 * otherwise the carrier would end up with two conflicting headers.
 */
function isMutableHeaderTupleArray(
  carrier: TraceContextCarrier,
): carrier is [string, string][] {
  return (
    Array.isArray(carrier) &&
    carrier.every((item) => Array.isArray(item) && typeof item[0] === "string")
  );
}

function setHeader(
  carrier: TraceContextCarrier,
  name: string,
  value: string,
): void {
  if (isMutableHeaderTupleArray(carrier)) {
    const lowered = name.toLowerCase();
    for (let i = carrier.length - 1; i >= 0; i--) {
      if (carrier[i][0].toLowerCase() === lowered) {
        carrier.splice(i, 1);
      }
    }
    carrier.push([name, value]);
    return;
  }

  const setter = (carrier as { set?: unknown }).set;
  if (typeof setter === "function") {
    const deleter = (carrier as { delete?: unknown }).delete;
    if (typeof deleter === "function") {
      try {
        deleter.call(carrier, name);
      } catch {
        // Setting below may still succeed for custom header-like objects.
      }
    }
    setter.call(carrier, name, value);
    return;
  }

  const nodeSetter = (carrier as { setHeader?: unknown }).setHeader;
  if (typeof nodeSetter === "function") {
    const remover = (carrier as { removeHeader?: unknown }).removeHeader;
    if (typeof remover === "function") {
      try {
        remover.call(carrier, name);
      } catch {
        // Setting below may still succeed for custom header-like objects.
      }
    }
    nodeSetter.call(carrier, name, value);
    return;
  }

  const headerSetter = (carrier as { header?: unknown }).header;
  if (typeof headerSetter === "function") {
    const deleter = (carrier as { delete?: unknown }).delete;
    if (typeof deleter === "function") {
      try {
        deleter.call(carrier, name);
      } catch {
        // Setting below may still succeed for custom header-like objects.
      }
    }
    const remover = (carrier as { removeHeader?: unknown }).removeHeader;
    if (typeof remover === "function") {
      try {
        remover.call(carrier, name);
      } catch {
        // Setting below may still succeed for custom header-like objects.
      }
    }
    headerSetter.call(carrier, name, value);
    return;
  }

  const headerBag = carrier as { [name: string]: string };
  const lowered = name.toLowerCase();
  for (const key of Object.keys(headerBag)) {
    if (key !== name && key.toLowerCase() === lowered) {
      delete headerBag[key];
    }
  }
  headerBag[name] = value;
}

function deleteHeader(carrier: TraceContextCarrier, name: string): void {
  const lowered = name.toLowerCase();
  if (isMutableHeaderTupleArray(carrier)) {
    for (let i = carrier.length - 1; i >= 0; i--) {
      if (carrier[i][0].toLowerCase() === lowered) {
        carrier.splice(i, 1);
      }
    }
    return;
  }

  const deleter = (carrier as { delete?: unknown }).delete;
  if (typeof deleter === "function") {
    try {
      deleter.call(carrier, name);
      return;
    } catch {
      // Fall through to other header carrier styles.
    }
  }

  const remover = (carrier as { removeHeader?: unknown }).removeHeader;
  if (typeof remover === "function") {
    try {
      remover.call(carrier, name);
      return;
    } catch {
      // Fall through to plain object cleanup.
    }
  }

  const headerBag = carrier as { [name: string]: string };
  for (const key of Object.keys(headerBag)) {
    if (key.toLowerCase() === lowered) {
      delete headerBag[key];
    }
  }
}

/**
 * Inject W3C trace-context headers into a carrier (in place).
 *
 * Emits `traceparent` from the hex trace/span ids, merges `braintrust.parent`
 * into existing `baggage` when known, and forwards any inbound W3C state
 * (`tracestate` plus the original `traceparent` trace-flags) carried in
 * `propagatedState`. Pre-existing, non-Braintrust baggage entries are preserved.
 */
export function _injectIntoCarrier(
  carrier: TraceContextCarrier,
  args: {
    traceId: string | undefined;
    spanId: string | undefined;
    braintrustParent: string | undefined | null;
    propagatedState?: PropagatedState | undefined;
  },
): void {
  // Re-emit the inbound trace-flags verbatim so the upstream sampling decision
  // (and any future flag bits) is preserved; defaults to sampled when we
  // originated the trace (no inbound flags).
  const traceFlags = args.propagatedState?.traceFlags;
  const traceparent = traceFlags
    ? formatTraceparent(args.traceId, args.spanId, traceFlags)
    : formatTraceparent(args.traceId, args.spanId);
  if (traceparent === undefined) {
    // Ids aren't W3C-shaped (e.g. legacy UUID mode); nothing to propagate.
    return;
  }
  setHeader(carrier, TRACEPARENT_HEADER, traceparent);

  // Forward upstream tracestate (per W3C, only alongside a valid traceparent).
  const tracestate = args.propagatedState?.tracestate;
  if (tracestate) {
    setHeader(carrier, TRACESTATE_HEADER, tracestate);
  }

  // Merge braintrust.parent into any existing baggage. Other vendors' members
  // are forwarded byte-for-byte (see mergeBaggage) so we never rewrite their
  // percent-encoding.
  const existing = getHeader(carrier, BAGGAGE_HEADER);
  const baggageValue = mergeBaggage(existing, args.braintrustParent);
  if (baggageValue !== undefined) {
    setHeader(carrier, BAGGAGE_HEADER, baggageValue);
  } else if (existing !== undefined) {
    // mergeBaggage returns undefined when the existing header only had a stale
    // braintrust.parent (or otherwise no members worth forwarding), so remove
    // the old header instead of letting a reused carrier propagate bad routing.
    // If left in place, a downstream service could attach this trace to the
    // previous project/experiment, or leak that parent to an unrelated request.
    deleteHeader(carrier, BAGGAGE_HEADER);
  }
}

/**
 * Inject W3C trace-context headers for the current (or given) span into a
 * carrier.
 *
 * This is the free-function form of {@link Span.inject}, and the send-side
 * counterpart of {@link extractTraceContextFromHeaders}. If no span is
 * provided, the currently-active span is used. Propagation is best-effort and
 * never throws.
 *
 * @param carrier Optional carrier (e.g. outbound HTTP headers) to mutate.
 *   Supports plain objects, Web `Headers`, Node-style `setHeader` carriers,
 *   framework `header` carriers, and mutable `HeadersInit` tuple arrays.
 * @param options.span Optional span to inject. Defaults to the current span.
 * @returns The carrier with propagation headers injected.
 */
export function injectTraceContext(
  carrier?: undefined,
  options?: OptionalStateArg & { span?: Span },
): Record<string, string>;

export function injectTraceContext<T extends TraceContextCarrier>(
  carrier: T,
  options?: OptionalStateArg & { span?: Span },
): T;

export function injectTraceContext<T extends TraceContextCarrier>(
  carrier?: T,
  options?: OptionalStateArg & { span?: Span },
): T | Record<string, string> {
  const resolvedCarrier = carrier ?? {};
  const span = options?.span ?? currentSpan({ state: options?.state });
  try {
    return span.inject(resolvedCarrier);
  } catch (e) {
    debugLogger.warn(`Error injecting trace context: ${e}`);
    return resolvedCarrier;
  }
}

/**
 * Extract an opaque W3C trace-context from inbound request headers.
 *
 * This is the receive-side counterpart of {@link Span.inject} /
 * {@link injectTraceContext}. The return value is an opaque propagation context
 * that can be passed as `parent` to `startSpan`:
 *
 * ```ts
 * const ctx = extractTraceContextFromHeaders(request.headers);
 * traced((span) => { ... }, { name: "handler", parent: ctx });
 * ```
 *
 * Only the W3C Trace Context headers are interpreted (`traceparent`, `baggage`,
 * `tracestate`); header lookups are case-insensitive. If no valid `traceparent`
 * is present, returns undefined (the caller starts a fresh root span). The
 * Braintrust container the trace is routed under is resolved when the span is
 * created: from the `braintrust.parent` baggage entry, or else the
 * currently-active logger/experiment.
 *
 * Callers should treat the return value as opaque.
 *
 * @param headers Inbound request headers (e.g. an HTTP framework's headers).
 * @returns An opaque context for `startSpan({ parent })`, or undefined.
 */
export function extractTraceContextFromHeaders(
  headers: TraceContextHeaders | null | undefined,
): PropagationContext | undefined {
  if (!headers) {
    return undefined;
  }

  const traceparent = getHeader(headers, TRACEPARENT_HEADER);
  if (!traceparent || parseTraceparent(traceparent) === undefined) {
    return undefined;
  }

  const context: PropagationContext = { [TRACEPARENT_HEADER]: traceparent };
  const baggageValue = getHeader(headers, BAGGAGE_HEADER);
  if (baggageValue) {
    context[BAGGAGE_HEADER] = baggageValue;
  }
  const tracestate = getHeader(headers, TRACESTATE_HEADER);
  if (tracestate) {
    // `tracestate` is opaque vendor state that we forward but never author or
    // interpret. It is passed along unchanged; receivers that want to use it
    // validate it themselves, per the W3C Trace Context spec.
    context[TRACESTATE_HEADER] = tracestate;
  }
  return context;
}

/**
 * Resolve a W3C trace-context into `{ parentSlug, propagatedState }`.
 *
 * Reads `traceparent` for trace identity and `braintrust.parent` from `baggage`
 * (falling back to the currently-active logger/experiment) for routing, and
 * builds an internal Braintrust parent slug. Captures the `tracestate` and raw
 * `traceparent` flags to forward onward. Returns `{ undefined, undefined }` if
 * the context cannot be resolved into a usable parent (so the caller falls back
 * to local precedence / a fresh root).
 */
function resolveW3cParent(
  context: PropagationContext,
  state?: BraintrustState,
): {
  parentSlug: string | undefined;
  propagatedState: PropagatedState | undefined;
} {
  const traceparent = getHeader(context, TRACEPARENT_HEADER);
  const parsed = traceparent ? parseTraceparent(traceparent) : undefined;
  if (parsed === undefined) {
    return { parentSlug: undefined, propagatedState: undefined };
  }
  const { traceId, spanId, traceFlags } = parsed;

  // Determine the Braintrust container: baggage -> current logger/experiment.
  let braintrustParent: string | undefined = undefined;
  const baggageValue = getHeader(context, BAGGAGE_HEADER);
  if (baggageValue) {
    braintrustParent = parseBaggage(baggageValue)[BRAINTRUST_PARENT_KEY];
  }
  if (!braintrustParent) {
    braintrustParent = currentBraintrustParent(state);
  }
  if (!braintrustParent) {
    debugLogger.warn(
      "Received traceparent without a braintrust.parent and no active logger/experiment; " +
        "cannot route the trace. Starting a fresh local span instead.",
    );
    return { parentSlug: undefined, propagatedState: undefined };
  }

  const parsedParent = braintrustParentToComponents(braintrustParent);
  if (parsedParent === undefined) {
    debugLogger.warn(
      `Invalid braintrust.parent: ${JSON.stringify(braintrustParent)}`,
    );
    return { parentSlug: undefined, propagatedState: undefined };
  }
  const { objectType, objectId, computeArgs } = parsedParent;

  // `tracestate` is opaque vendor state, forwarded unchanged and never
  // authored or interpreted by Braintrust.
  const tracestate = getHeader(context, TRACESTATE_HEADER);

  const slug = new SpanComponentsV4({
    object_type: objectType,
    ...(computeArgs
      ? { compute_object_metadata_args: computeArgs }
      : { object_id: objectId }),
    row_id: "bt-propagation", // non-empty to enable span_id/root_span_id
    span_id: spanId,
    root_span_id: traceId,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  } as SpanComponentsV4Data).toStr();
  return {
    parentSlug: slug,
    propagatedState: { tracestate, traceFlags, braintrustParent },
  };
}

/**
 * Normalize a `parent` argument into `{ parentSlug, propagatedState }`.
 *
 * - object -> interpreted as a W3C trace-context (from
 *   `extractTraceContextFromHeaders`)
 * - string -> an exported span slug (passed through unchanged)
 * - undefined -> no parent
 *
 * `propagatedState` carries any inbound W3C state (tracestate + raw flags) to
 * forward on the next `inject`; it is undefined when there is no inbound W3C
 * context.
 */
function normalizeParent(
  parent: string | PropagationContext | undefined | null,
  state?: BraintrustState,
): {
  parentSlug: string | undefined;
  propagatedState: PropagatedState | undefined;
} {
  if (parent && typeof parent === "object") {
    return resolveW3cParent(parent, state);
  }
  return {
    parentSlug: parent ?? undefined,
    propagatedState: undefined,
  };
}

/**
 * Return true if a parent slug carries span ids the child can link to.
 *
 * A child links to any parent slug that carries both a span id and a root span
 * id, regardless of whether those ids are hex (the default) or legacy UUID. This
 * keeps the deprecated `startSpan({ parent: <slug> })` path backwards
 * compatible: a slug exported by an older (UUID) sender still links into a trace
 * on a newer (hex) receiver, and vice versa. The child's own freshly generated
 * span id stays in the active format; the backend supports traces whose nodes
 * mix id formats across a propagation boundary. Empty ids (no row) are handled
 * by the caller.
 */
function parentSpanIdsUsable(
  spanId: string | undefined | null,
  rootSpanId: string | undefined | null,
): boolean {
  return Boolean(spanId) && Boolean(rootSpanId);
}

export function logError(span: Span, error: unknown): void {
  let errorMessage = "<error>";
  let stackTrace = "";
  if (error instanceof Error) {
    errorMessage = error.message;
    stackTrace = error.stack || "";
  } else {
    errorMessage = String(error);
  }
  span.log({ error: `${errorMessage}\n\n${stackTrace}` });
}

/**
 * Toplevel function for starting a span. It checks the following (in precedence order):
 *  * Currently-active span
 *  * Currently-active experiment
 *  * Currently-active logger
 *
 * and creates a span under the first one that is active. Alternatively, if `parent` is specified, it creates a span under the specified parent row. If none of these are active, it returns a no-op span object.
 *
 * See {@link Span.traced} for full details.
 */
export function traced<R>(
  callback: (span: Span) => R,
  args?: StartSpanArgs & SetCurrentArg & OptionalStateArg,
): R {
  const { setCurrent, ...spanArgs } = args ?? {};
  const span = startSpanImpl(spanArgs);

  return runCatchFinally(
    () => {
      if (setCurrent ?? true) {
        return withCurrent(span, callback);
      } else {
        return callback(span);
      }
    },
    (error) => {
      logError(span, error);
      throw error;
    },
    () => span.end(),
  );
}

type WrapTracedArgs = {
  noTraceIO?: boolean;
};

/**
 * Check if a function is a sync generator function.
 *
 * Note: This uses Object.prototype.toString which is sufficient for environments that
 * support generator functions (ES6+). While our code is compiled to ES2022, consumers
 * may run it in various environments. However, if generators aren't supported in their
 * environment, the generator functions themselves won't work anyway, making detection moot.
 *
 * @param fn The function to check.
 * @returns True if the function is a sync generator function.
 */
export function isGeneratorFunction(fn: unknown): boolean {
  return Object.prototype.toString.call(fn) === "[object GeneratorFunction]";
}

/**
 * Check if a function is an async generator function.
 *
 * Note: see isGeneratorFunction disclaimer
 * @param fn The function to check.
 * @returns True if the function is an async generator function.
 */
export function isAsyncGeneratorFunction(fn: unknown): boolean {
  return (
    Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]"
  );
}

/**
 * Wrap a sync generator function with tracing.
 */
function wrapTracedSyncGenerator<F extends (...args: any[]) => any>(
  fn: F,
  spanArgs: StartSpanArgs & SetCurrentArg,
  noTraceIO: boolean,
): F {
  const wrapper = function* (
    this: ThisParameterType<F>,
    ...fnArgs: Parameters<F>
  ) {
    const span = startSpan(spanArgs);
    try {
      if (!noTraceIO) {
        span.log({ input: fnArgs });
      }

      const maxItems = getNumericEnv("BRAINTRUST_MAX_GENERATOR_ITEMS") ?? 1000;

      if (!noTraceIO && maxItems !== 0) {
        let collected: unknown[] = [];
        let truncated = false;

        const gen = generatorWithCurrent(span, fn.apply(this, fnArgs));
        try {
          for (const value of gen) {
            if (
              maxItems === -1 ||
              (!truncated && collected.length < maxItems)
            ) {
              collected.push(value);
            } else {
              truncated = true;
              collected = [];
              debugLogger.warn(
                `Generator output exceeded limit of ${maxItems} items, output not logged. ` +
                  `Increase BRAINTRUST_MAX_GENERATOR_ITEMS or set to -1 to disable limit.`,
              );
            }
            yield value;
          }

          if (!truncated) {
            span.log({ output: collected });
          }
        } catch (error) {
          logError(span, error);
          if (!truncated && collected.length > 0) {
            span.log({ output: collected });
          }
          throw error;
        }
      } else {
        // No output collection
        const gen = generatorWithCurrent(span, fn.apply(this, fnArgs));
        for (const value of gen) {
          yield value;
        }
      }
    } finally {
      span.end();
    }
  };
  // Preserve the original function name
  Object.defineProperty(wrapper, "name", { value: fn.name });
  return wrapper as F;
}

/**
 * Wrap an async generator function with tracing.
 */
function wrapTracedAsyncGenerator<F extends (...args: any[]) => any>(
  fn: F,
  spanArgs: StartSpanArgs & SetCurrentArg,
  noTraceIO: boolean,
): F {
  const wrapper = async function* (
    this: ThisParameterType<F>,
    ...fnArgs: Parameters<F>
  ) {
    const span = startSpan(spanArgs);
    try {
      if (!noTraceIO) {
        span.log({ input: fnArgs });
      }

      const maxItems = getNumericEnv("BRAINTRUST_MAX_GENERATOR_ITEMS") ?? 1000;

      if (!noTraceIO && maxItems !== 0) {
        let collected: unknown[] = [];
        let truncated = false;

        const gen = asyncGeneratorWithCurrent(span, fn.apply(this, fnArgs));
        try {
          for await (const value of gen) {
            if (
              maxItems === -1 ||
              (!truncated && collected.length < maxItems)
            ) {
              collected.push(value);
            } else {
              truncated = true;
              collected = [];
              debugLogger.warn(
                `Generator output exceeded limit of ${maxItems} items, output not logged. ` +
                  `Increase BRAINTRUST_MAX_GENERATOR_ITEMS or set to -1 to disable limit.`,
              );
            }
            yield value;
          }

          if (!truncated) {
            span.log({ output: collected });
          }
        } catch (error) {
          logError(span, error);
          if (!truncated && collected.length > 0) {
            span.log({ output: collected });
          }
          throw error;
        }
      } else {
        // No output collection
        const gen = asyncGeneratorWithCurrent(span, fn.apply(this, fnArgs));
        for await (const value of gen) {
          yield value;
        }
      }
    } finally {
      span.end();
    }
  };
  // Preserve the original function name
  Object.defineProperty(wrapper, "name", { value: fn.name });
  return wrapper as F;
}

/**
 * Wrap a function with `traced`, using the arguments as `input` and return value as `output`.
 * Any functions wrapped this way will automatically be traced, similar to the `@traced` decorator
 * in Python. If you want to correctly propagate the function's name and define it in one go, then
 * you can do so like this:
 *
 * ```ts
 * const myFunc = wrapTraced(async function myFunc(input) {
 *  const result = await client.chat.completions.create({
 *    model: "gpt-3.5-turbo",
 *    messages: [{ role: "user", content: input }],
 *  });
 *  return result.choices[0].message.content ?? "unknown";
 * },
 * // Optional: if you're using a framework like NextJS that minifies your code, specify the function name and it will be used for the span name
 * { name: "myFunc" },
 * );
 * ```
 * Now, any calls to `myFunc` will be traced, and the input and output will be logged automatically.
 * If tracing is inactive, i.e. there is no active logger or experiment, it's just a no-op.
 *
 * @param fn The function to wrap.
 * @param args Span-level arguments (e.g. a custom name or type) to pass to `traced`.
 * @returns The wrapped function.
 */
export function wrapTraced<F extends (...args: any[]) => any>(
  fn: F,
  args?: StartSpanArgs & SetCurrentArg & WrapTracedArgs,
): F {
  const { noTraceIO, ...argsRest } = args ?? {};
  const spanArgs: StartSpanArgs & SetCurrentArg = {
    name: fn.name,
    type: "function",
    ...argsRest,
  };
  const hasExplicitInput = spanArgs.event?.input !== undefined;
  const hasExplicitOutput = spanArgs.event?.output !== undefined;

  const disableGeneratorTraceIO =
    !!noTraceIO || hasExplicitInput || hasExplicitOutput;
  // Check if the function is a generator
  if (isGeneratorFunction(fn)) {
    return wrapTracedSyncGenerator(fn, spanArgs, disableGeneratorTraceIO);
  }

  if (isAsyncGeneratorFunction(fn)) {
    return wrapTracedAsyncGenerator(fn, spanArgs, disableGeneratorTraceIO);
  }

  return ((...fnArgs: Parameters<F>) =>
    traced((span) => {
      if (!noTraceIO && !hasExplicitInput) {
        span.log({ input: fnArgs });
      }

      const output = fn(...fnArgs);

      if (!noTraceIO && !hasExplicitOutput) {
        if (output instanceof Promise) {
          return (async () => {
            const result = await output;
            span.log({ output: result });
            return result;
          })();
        } else {
          span.log({ output });
        }
      }

      return output;
    }, spanArgs)) as F;
}

/**
 * Lower-level alternative to `traced`. This allows you to start a span yourself, and can be useful in situations
 * where you cannot use callbacks. However, spans started with `startSpan` will not be marked as the "current span",
 * so `currentSpan()` and `traced()` will be no-ops. If you want to mark a span as current, use `traced` instead.
 *
 * See {@link traced} for full details.
 */
export function startSpan(args?: StartSpanArgs & OptionalStateArg): Span {
  return startSpanImpl(args);
}

export function _internalStartSpan(
  args?: InternalStartSpanArgs & OptionalStateArg,
): Span {
  return startSpanImpl(args);
}

/** @internal Start a span whose initial row is merged with concurrent writes. */
export function _internalStartSpanWithInitialMerge(
  args?: InternalStartSpanArgs & OptionalStateArg,
): Span {
  return startSpanImpl({
    ...args,
    [INITIAL_SPAN_WRITE_AS_MERGE]: true,
  } as InternalStartSpanArgs & OptionalStateArg & InitialSpanWriteAsMergeArg);
}

/** @internal Start a deterministic span under an exported object-only parent. */
export function _internalStartSpanWithInitialMergeAndParentSpanIds(
  args: InternalStartSpanArgs & OptionalStateArg,
): Span {
  return startSpanImpl(
    {
      ...args,
      [INITIAL_SPAN_WRITE_AS_MERGE]: true,
    } as InternalStartSpanArgs & OptionalStateArg & InitialSpanWriteAsMergeArg,
    { useParentSpanIdsForObjectParent: true },
  );
}

/** @internal Start a span with SDK-controlled context fields. */
export function _internalStartSpanWithContext(
  args: InternalStartSpanArgs & OptionalStateArg,
  context: Record<string, unknown>,
): Span {
  return startSpanImpl({
    ...args,
    [INTERNAL_SPAN_CONTEXT]: context,
  });
}

/**
 * Flush any pending rows to the server.
 */
export async function flush(options?: OptionalStateArg): Promise<void> {
  const state =
    options?.state ??
    _globalState ??
    (
      globalThis as typeof globalThis & {
        [key: symbol]: BraintrustState | undefined;
      }
    )[Symbol.for("braintrust-state")];
  await state?.bgLogger().flush();
}

/**
 * Set the fetch implementation to use for requests. You can specify it here,
 * or when you call `login`.
 *
 * @param fetch The fetch implementation to use.
 */
export function setFetch(fetch: typeof globalThis.fetch): void {
  _internalGetGlobalState().setFetch(fetch);
}

function startSpanImpl(
  args?: InternalStartSpanArgs & OptionalStateArg & InternalSpanContextArg,
  internalOptions?: { useParentSpanIdsForObjectParent?: boolean },
): Span {
  const state = args?.state ?? _internalGetGlobalState();

  // Resolve the parent object and any forwarded W3C state in one pass, so we
  // don't re-normalize `parent` (which could disagree if the active
  // logger/experiment changed between calls).
  const { parentObject, propagatedState } =
    getSpanParentObjectAndPropagatedState(args);

  if (
    parentObject instanceof SpanComponentsV3 ||
    parentObject instanceof SpanComponentsV4
  ) {
    const parentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined =
      parentObject.data.row_id &&
      parentSpanIdsUsable(
        parentObject.data.span_id,
        parentObject.data.root_span_id,
      )
        ? {
            spanId: parentObject.data.span_id,
            rootSpanId: parentObject.data.root_span_id,
          }
        : internalOptions?.useParentSpanIdsForObjectParent
          ? args?.parentSpanIds
          : undefined;
    // The parent object/state are already resolved from `parent` above; drop
    // the raw `parent` so it isn't re-normalized.
    const { parent: _ignoredParent, ...spanArgs } = args ?? {};
    return new SpanImpl({
      state,
      ...spanArgs,
      parentObjectType: parentObject.data.object_type,
      parentObjectId: new LazyValue(
        spanComponentsToObjectIdLambda(state, parentObject),
      ),
      parentComputeObjectMetadataArgs:
        parentObject.data.compute_object_metadata_args ?? undefined,
      parentSpanIds,
      propagatedEvent:
        args?.propagatedEvent ??
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        ((parentObject.data.propagated_event ?? undefined) as
          | StartSpanEventArgs
          | undefined),
      propagatedState,
    });
  } else {
    // The internal entrypoint still accepts exported Braintrust parent slugs.
    // Span implementations support that runtime form even though it is no
    // longer part of their public method signature.
    return parentObject.startSpan(args as StartSpanArgs);
  }
}

/**
 * Runs the provided callback with the span as the current span.
 */
export function withCurrent<R>(
  span: Span,
  callback: (span: Span) => R,
  state: BraintrustState | undefined = undefined,
): R {
  const currentState = state ?? _internalGetGlobalState();
  return currentState.contextManager.runInContext(span, () => callback(span));
}

/**
 * Wraps a sync generator to maintain the current span context across yields.
 */
function* generatorWithCurrent<T>(
  span: Span,
  gen: Generator<T, any, any>,
  state: BraintrustState | undefined = undefined,
): Generator<T, any, any> {
  let nextValue: any;
  while (true) {
    const result = withCurrent(
      span,
      () => {
        try {
          return gen.next(nextValue);
        } catch (e) {
          // Handle generator.throw()
          return { value: undefined, done: true, error: e };
        }
      },
      state,
    );

    if ("error" in result) {
      throw result.error;
    }

    if (result.done) {
      return result.value;
    }

    nextValue = yield result.value;
  }
}

/**
 * Wraps an async generator to maintain the current span context across yields.
 */
async function* asyncGeneratorWithCurrent<T>(
  span: Span,
  gen: AsyncGenerator<T, any, any>,
  state: BraintrustState | undefined = undefined,
): AsyncGenerator<T, any, any> {
  let nextValue: any;
  while (true) {
    const result = await withCurrent(
      span,
      async () => {
        try {
          return await gen.next(nextValue);
        } catch (e) {
          // Handle generator.throw()
          return { value: undefined, done: true, error: e };
        }
      },
      state,
    );

    if ("error" in result) {
      throw result.error;
    }

    if (result.done) {
      return result.value;
    }

    nextValue = yield result.value;
  }
}

export function withParent<R>(
  parent: PropagationContext,
  callback: () => R,
  state: BraintrustState | undefined = undefined,
): R {
  return (state ?? _internalGetGlobalState()).currentParent.run(parent, () =>
    callback(),
  );
}

export function _internalWithParent<R>(
  parent: string | PropagationContext,
  callback: () => R,
  state: BraintrustState | undefined = undefined,
): R {
  return (state ?? _internalGetGlobalState()).currentParent.run(parent, () =>
    callback(),
  );
}

function _saveOrgInfo(
  state: BraintrustState,
  orgInfo: any,
  orgName: string | undefined,
) {
  const org = selectLoginOrg(orgInfo, orgName);
  state.orgId = org.id;
  state.orgName = org.name;
  state.apiUrl = iso.getEnv("BRAINTRUST_API_URL") || org.api_url;
  state.proxyUrl = iso.getEnv("BRAINTRUST_PROXY_URL") || org.proxy_url;
  state.gitMetadataSettings = org.git_metadata || undefined;
}

function selectLoginOrg(orgInfo: any, orgName: string | undefined) {
  if (orgInfo.length === 0) {
    throw new LoginInvalidOrgError(
      "This user is not part of any organizations.",
    );
  }

  for (const org of orgInfo) {
    if (orgName === undefined || org.name === orgName) {
      return org;
    }
  }

  throw new LoginInvalidOrgError(
    `Organization ${orgName} not found. Must be one of ${orgInfo
      .map((org: any) => org.name)
      .join(", ")}`,
  );
}

export function validateTags(tags: readonly string[]): void {
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") {
      throw new Error("tags must be strings");
    }

    if (seen.has(tag)) {
      throw new Error(`duplicate tag: ${tag}`);
    }
    seen.add(tag);
  }
}

function validateAndSanitizeExperimentLogPartialArgs(
  event: ExperimentLogPartialArgs,
): SanitizedExperimentLogPartialArgs {
  if (event.scores) {
    if (Array.isArray(event.scores)) {
      throw new Error("scores must be an object, not an array");
    }
    for (const [name, rawScore] of Object.entries(event.scores)) {
      let score = rawScore;
      if (typeof name !== "string") {
        throw new Error("score names must be strings");
      }

      if (score === null || score === undefined) {
        continue;
      }

      if (typeof score === "boolean") {
        score = score ? 1 : 0;
        event.scores[name] = score;
      }

      if (typeof score !== "number") {
        throw new Error("score values must be numbers");
      }
      if (score < 0 || score > 1) {
        throw new Error("score values must be between 0 and 1");
      }
    }
  }

  if (event.metadata) {
    for (const key of Object.keys(event.metadata)) {
      if (typeof key !== "string") {
        throw new Error("metadata keys must be strings");
      }
    }
  }

  if (event.metrics) {
    for (const [key, value] of Object.entries(event.metrics)) {
      if (typeof key !== "string") {
        throw new Error("metric keys must be strings");
      }

      if (value !== undefined && typeof value !== "number") {
        throw new Error("metric values must be numbers");
      }
    }
  }

  if ("tags" in event && event.tags) {
    validateTags(event.tags);
  }

  return { ...event };
}

/**
 * Creates a deep copy of the given event. Replaces references to user objects
 * with placeholder strings to ensure serializability, except for
 * {@link Attachment} and {@link ExternalAttachment} objects, which are preserved
 * and not deep-copied.
 */
export function deepCopyEvent<T extends Partial<BackgroundLogEvent>>(
  event: T,
): T {
  const attachments: BaseAttachment[] = [];
  const ATTACHMENT_INDEX_KEY = "_bt_internal_saved_attachment_idx";
  const ATTACHMENT_MARKER_KEY = "_bt_internal_saved_attachment_marker";
  const attachmentMarker = ++deepCopyEventMarkerCounter;

  // We both check for serializability and round-trip `event` through JSON in
  // order to create a "deep copy". This has the benefit of cutting out any
  // reference to user objects when the object is logged asynchronously, so that
  // in case the objects are modified, the logging is unaffected. In the future,
  // this could be changed to a "real" deep copy so that immutable types (long
  // strings) do not have to be copied.
  const serialized = JSON.stringify(event, (_k, v) => {
    if (v instanceof Error) {
      return v.message;
    } else if (v instanceof SpanImpl || v instanceof NoopSpan) {
      return `<span>`;
    } else if (
      v &&
      typeof v === "object" &&
      v.__braintrust_experiment_marker === true
    ) {
      return `<experiment>`;
    } else if (
      v &&
      typeof v === "object" &&
      v.__braintrust_dataset_marker === true
    ) {
      return `<dataset>`;
    } else if (v instanceof Logger) {
      return `<logger>`;
    } else if (v instanceof BaseAttachment) {
      const idx = attachments.push(v);
      return {
        [ATTACHMENT_INDEX_KEY]: idx - 1,
        [ATTACHMENT_MARKER_KEY]: attachmentMarker,
      };
    } else if (v instanceof ReadonlyAttachment) {
      return v.reference;
    }
    return v;
  });
  const x = JSON.parse(serialized, (_k, v) => {
    if (isDeepCopyAttachmentPlaceholder(v, attachmentMarker)) {
      return attachments[v[ATTACHMENT_INDEX_KEY]];
    }
    return v;
  });
  return x;
}

let deepCopyEventMarkerCounter = 0;

function isDeepCopyAttachmentPlaceholder(
  value: unknown,
  attachmentMarker: number,
): value is Record<
  "_bt_internal_saved_attachment_idx" | "_bt_internal_saved_attachment_marker",
  number
> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    !Object.hasOwn(record, "_bt_internal_saved_attachment_idx") ||
    !Object.hasOwn(record, "_bt_internal_saved_attachment_marker")
  ) {
    return false;
  }

  if (Object.keys(record).length !== 2) {
    return false;
  }

  const attachmentIndex = record._bt_internal_saved_attachment_idx as number;
  const marker = record._bt_internal_saved_attachment_marker;

  return (
    Number.isInteger(attachmentIndex) &&
    attachmentIndex >= 0 &&
    marker === attachmentMarker
  );
}

/**
 * Helper function for uploading attachments. Recursively extracts `Attachment`
 * and `ExternalAttachment` objects and replaces them with their associated
 * `AttachmentReference` objects.
 *
 * @param event The event to filter. Will be modified in-place.
 * @param attachments Flat array of extracted attachments (output parameter).
 */
export function extractAttachments(
  event: Record<string, any>,
  attachments: BaseAttachment[],
): void {
  const pending: {
    event: Record<string, any>;
    key: string;
    attachment: BaseAttachment;
  }[] = [];
  let automatic = false;
  const walk = (event: Record<string, any>, depth = 0): void => {
    if (depth >= 128) return;
    for (const [key, value] of Object.entries(event)) {
      if (!value) {
        continue;
      }

      // Base case: Attachment or ExternalAttachment.
      if (value instanceof BaseAttachment) {
        automatic ||= automaticAttachmentOriginals.has(value);
        pending.push({ event, key, attachment: value });
        continue; // Attachment cannot be nested.
      }

      // Skip if this is already just a reference (no uploader field)
      if (
        [
          BRAINTRUST_ATTACHMENT,
          EXTERNAL_ATTACHMENT,
          "inline_attachment",
        ].includes(value?.type)
      ) {
        // This is already just a reference, skip it
        continue;
      }

      // Somewhere in our pipeline we're serializing the attachment and then deserializing it.
      // This loses the instanceof identity of the attachment, so we need to recreate it because
      // the above instance check doesn't catch it.
      if (value?.reference?.type === BRAINTRUST_ATTACHMENT && value?.uploader) {
        // This looks like a serialized Attachment object, recreate it properly
        const attachment = new Attachment({
          data: value.dataDebugString,
          filename: value.reference.filename,
          contentType: value.reference.content_type,
        });
        pending.push({ event, key, attachment });
        continue;
      }

      // Base case: non-object.
      if (!(value instanceof Object)) {
        continue; // Nothing to explore recursively.
      }

      // Recursive case: object or array.
      walk(value, depth + 1);
    }
  };
  const queueLength = attachments.length;
  try {
    walk(event);
    // Read all references and enqueue before committing any replacement.
    const references = pending.map(({ attachment }) => attachment.reference);
    for (const { attachment } of pending) attachments.push(attachment);
    pending.forEach(({ event, key }, index) => {
      event[key] = references[index];
    });
  } catch (error) {
    attachments.length = queueLength;
    if (!automatic) throw error;
    Object.assign(event, restoreAutomaticAttachments(event));
  }
}

function collectAttachmentReferenceKeys(value: unknown, keys: Set<string>) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectAttachmentReferenceKeys(item, keys));
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === BRAINTRUST_ATTACHMENT && typeof record.key === "string") {
    keys.add(record.key);
    return;
  }
  Object.values(record).forEach((item) =>
    collectAttachmentReferenceKeys(item, keys),
  );
}

/**
 * Recursively hydrates any `AttachmentReference` into `Attachment` by modifying
 * the input in-place.
 *
 * @returns The same event instance as the input.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function enrichAttachments<T extends Record<string, any>>(
  event: T,
  state: BraintrustState | undefined,
): T {
  for (const [key, value] of Object.entries(event)) {
    // Base case: AttachmentReference.
    const parsedValue = attachmentReferenceSchema.safeParse(value);
    if (parsedValue.success) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
      (event as any)[key] = new ReadonlyAttachment(parsedValue.data, state);
      continue;
    }

    // Base case: non-object.
    if (!(value instanceof Object)) {
      continue;
    }

    // Recursive case: object or array:
    enrichAttachments(value, state);
  }

  return event;
}

/**
 * Recursively hydrates any `AttachmentReference` into `Attachment` by modifying
 * the input in-place.
 *
 * @returns The same event instance as the input.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveAttachmentsToBase64<T extends Record<string, any>>(
  event: T,
  state: BraintrustState | undefined,
): Promise<T> {
  for (const [key, value] of Object.entries(event)) {
    if (value instanceof ReadonlyAttachment) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
      (event as any)[key] = await value.asBase64Url();
      continue;
    }

    // Base case: non-object.
    if (!(value instanceof Object)) {
      continue;
    }

    // Recursive case: object or array:
    await resolveAttachmentsToBase64(value, state);
  }

  return event;
}

// Note that this only checks properties that are expected of a complete event.
// validateAndSanitizeExperimentLogPartialArgs should still be invoked (after
// handling special fields like 'id').
export function validateAndSanitizeExperimentLogFullArgs(
  event: ExperimentLogFullArgs,
): ExperimentLogFullArgs {
  if (!("input" in event)) {
    throw new Error("input must be specified");
  }

  if (isEmpty(event.output)) {
    throw new Error("output must be specified");
  }
  if (isEmpty(event.scores)) {
    throw new Error("scores must be specified");
  }

  return event;
}

export type BaseMetadata = Record<string, unknown> | void;

export type DefaultMetadataType = void;

export type EvalCaseOrigin = ObjectReference;

export type EvalCase<Input, Expected, Metadata> = {
  input: Input;
  tags?: string[];
  // These fields are only set if the EvalCase is part of a Dataset.
  id?: string;
  _xact_id?: TransactionId;
  created?: string | null;
  origin?: EvalCaseOrigin;
  // This field is used to help re-run a particular experiment row.
  upsert_id?: string;
  // The number of times to run the evaluator for this specific input.
  trialCount?: number;
} & (Expected extends void ? object : { expected: Expected }) &
  (Metadata extends void ? object : { metadata: Metadata });

let executionCounter = 0;

export function newId(): string {
  return uuidv4();
}

interface ResolvedSpanIds {
  spanId: string;
  rootSpanId: string;
  spanParents: string[] | undefined;
}

/**
 * Resolve all span IDs (span_id, root_span_id, span_parents) from explicit values, parent info, or context.
 *
 * @param spanId - Optional explicit span_id (from public API)
 * @param parentSpanIds - Optional explicit parent span IDs (from parent string or parent span)
 * @param lookupSpanParent - Whether to look up parent from context manager if no explicit parent.
 *   - True (default): start_span() inherits parent/root ids from the active span (if it exists)
 *   - False: don't look up parent in context (e.g. logger.log() doesn't inherit context)
 * @param idGenerator - ID generator for creating new span/trace IDs
 * @param contextManager - Context manager for looking up parent spans
 * @returns ResolvedSpanIds with resolved span_id, root_span_id, and span_parents
 */
function _resolveSpanIds(
  spanId: string | undefined,
  parentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined,
  lookupSpanParent: boolean,
  idGenerator: IDGenerator,
  contextManager: ContextManager,
): ResolvedSpanIds {
  // Generate span_id if not provided
  const resolvedSpanId = spanId ?? idGenerator.getSpanId();

  // If we have explicit parent span ids, use them.
  if (parentSpanIds) {
    return {
      spanId: resolvedSpanId,
      rootSpanId: parentSpanIds.rootSpanId,
      spanParents:
        "parentSpanIds" in parentSpanIds
          ? parentSpanIds.parentSpanIds
          : [parentSpanIds.spanId],
    };
  }

  // If we're using the context manager, see if there's an active parent span.
  if (lookupSpanParent) {
    const parentInfo = contextManager.getParentSpanIds();
    if (parentInfo) {
      return {
        spanId: resolvedSpanId,
        rootSpanId: parentInfo.rootSpanId,
        spanParents: parentInfo.spanParents,
      };
    }
  }

  // No parent - create new root span
  // Root span ID behavior differs between UUID and OTEL generators:
  // - UUID (legacy): root_span_id === span_id for backwards compatibility
  // - OTEL: root_span_id is a separate trace ID, following OpenTelemetry convention
  //   where trace_id (root_span_id) represents the entire trace, distinct from
  //   the individual span's ID
  let resolvedRootSpanId: string;
  if (idGenerator.shareRootSpanId()) {
    resolvedRootSpanId = resolvedSpanId; // Backwards compat for UUID mode
  } else {
    resolvedRootSpanId = idGenerator.getTraceId();
  }

  return {
    spanId: resolvedSpanId,
    rootSpanId: resolvedRootSpanId,
    spanParents: undefined,
  };
}

/**
 * Primary implementation of the `Span` interface. See {@link Span} for full details on each method.
 *
 * We suggest using one of the various `traced` methods, instead of creating Spans directly. See {@link Span.startSpan} for full details.
 */
export class SpanImpl implements Span {
  private _state: BraintrustState;

  private isMerge: boolean;
  private loggedEndTime: number | undefined;
  private propagatedEvent: StartSpanEventArgs | undefined;

  // For internal use only.
  private parentObjectType: SpanObjectTypeV3;
  private parentObjectId: LazyValue<string>;
  private parentComputeObjectMetadataArgs: Record<string, any> | undefined;

  private _id: string;
  private _spanId: string;
  private _rootSpanId: string;
  private _spanParents: string[] | undefined;

  // Inbound W3C trace-context state (tracestate + raw traceparent flags) to
  // forward on outbound propagation. Captured at the span that received it (via
  // extractTraceContextFromHeaders) and inherited by all subspans, so that any
  // inject() within the trace re-emits the upstream state unchanged, per the W3C
  // Trace Context spec. Not interpreted.
  private _propagatedState: PropagatedState | undefined;

  public kind = "span" as const;

  constructor(
    args: {
      state: BraintrustState;
      parentObjectType: SpanObjectTypeV3;
      parentObjectId: LazyValue<string>;
      parentComputeObjectMetadataArgs: Record<string, any> | undefined;
      parentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined;
      defaultRootType?: SpanType;
      spanId?: string;
      propagatedState?: PropagatedState | undefined;
      [CAPTURE_ATTACHMENTS]?: boolean;
    } & Omit<StartSpanArgs, "parent"> &
      InitialSpanWriteAsMergeArg &
      InternalSpanContextArg,
  ) {
    this._state = args.state;
    Object.defineProperty(this, CAPTURE_ATTACHMENTS, {
      value:
        args[CAPTURE_ATTACHMENTS] ??
        args.state.autoCaptureAttachments ??
        autoCaptureAttachmentsFromEnv(),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    this._propagatedState = args.propagatedState;
    const instrumentationName =
      getSpanInstrumentationName(args) ??
      INSTRUMENTATION_NAMES.BRAINTRUST_JS_LOGGER;

    const spanAttributes = args.spanAttributes ?? {};
    const rawEvent = args.event ?? {};
    const type =
      args.type ?? (args.parentSpanIds ? undefined : args.defaultRootType);

    this.loggedEndTime = undefined;
    this.parentObjectType = args.parentObjectType;
    this.parentObjectId = args.parentObjectId;
    this.parentComputeObjectMetadataArgs = args.parentComputeObjectMetadataArgs;

    // Merge propagatedEvent into event. The propagatedEvent data will get
    // propagated-and-merged into every subspan.
    this.propagatedEvent = args.propagatedEvent;
    if (this.propagatedEvent) {
      mergeDicts(rawEvent, this.propagatedEvent);
    }
    const { id: eventId, ...event } = rawEvent;

    const callerLocation = iso.getCallerLocation();
    const name = (() => {
      if (args.name) return args.name;
      if (!args.parentSpanIds) return "root";
      if (callerLocation) {
        const pathComponents = callerLocation.caller_filename.split("/");
        const filename = pathComponents[pathComponents.length - 1];
        return [callerLocation.caller_functionname]
          .concat(
            filename ? [`${filename}:${callerLocation.caller_lineno}`] : [],
          )
          .join(":");
      }
      return "subspan";
    })();

    const internalData = {
      metrics: {
        start: args.startTime ?? getCurrentUnixTimestamp(),
      },
      context: mergeSpanOriginContext(
        { ...callerLocation, ...args[INTERNAL_SPAN_CONTEXT] },
        instrumentationName,
        this._state.spanOriginEnvironment,
      ),
      span_attributes: {
        name,
        type,
        ...spanAttributes,
        exec_counter: executionCounter++,
      },
      created: new Date().toISOString(),
    };

    this._id = eventId ?? this._state.idGenerator.getSpanId();

    // Resolve span IDs using the helper function that matches Python's _resolve_span_ids
    const resolvedIds = _resolveSpanIds(
      args.spanId,
      args.parentSpanIds,
      true, // Always lookup span parent from context manager unless explicit parent provided
      this._state.idGenerator,
      this._state.contextManager,
    );

    this._spanId = resolvedIds.spanId;
    this._rootSpanId = resolvedIds.rootSpanId;
    this._spanParents = resolvedIds.spanParents;

    // Deterministic spans can be initialized concurrently by separate
    // workflow executions, so their first write must not replace later merges.
    this.isMerge = args[INITIAL_SPAN_WRITE_AS_MERGE] === true;
    if (!args[RESUME_SPAN_WITHOUT_INITIAL_WRITE]) {
      this.logInternal({ event, internalData });
    }
    this.isMerge = true;
  }

  public getParentInfo(): {
    objectType: SpanObjectTypeV3;
    objectId: LazyValue<string>;
    computeObjectMetadataArgs: { [x: string]: any } | undefined;
  } {
    return {
      objectType: this.parentObjectType,
      objectId: this.parentObjectId,
      computeObjectMetadataArgs: this.parentComputeObjectMetadataArgs && {
        ...this.parentComputeObjectMetadataArgs,
      },
    };
  }

  public get id(): string {
    return this._id;
  }

  public get spanId(): string {
    return this._spanId;
  }

  public get rootSpanId(): string {
    return this._rootSpanId;
  }

  public get spanParents(): string[] {
    return this._spanParents ?? [];
  }

  public setAttributes(args: Omit<StartSpanArgs, "event">): void {
    this.logInternal({ internalData: { span_attributes: args } });
  }

  public setSpanParents(parents: string[]): void {
    this.logInternal({ internalData: { span_parents: parents } });
  }

  public log(event: ExperimentLogPartialArgs): void {
    this.logInternal({ event });
  }

  private logInternal({
    event,
    internalData,
  }: {
    event?: ExperimentLogPartialArgs;
    // `internalData` contains fields that are not part of the "user-sanitized"
    // set of fields which we want to log in just one of the span rows.
    internalData?: Partial<ExperimentEvent>;
  }): void {
    const [serializableInternalData, lazyInternalData] = splitLoggingData({
      event,
      internalData,
    });

    // Deep copy mutable user data.
    const partialRecord = deepCopyEvent({
      id: this.id,
      span_id: this._spanId,
      root_span_id: this._rootSpanId,
      span_parents: this._spanParents,
      ...serializableInternalData,
      [IS_MERGE_FIELD]: this.isMerge,
    });

    if (typeof partialRecord.metrics?.end === "number") {
      this.loggedEndTime = partialRecord.metrics.end;
    }

    // Write to local span cache for scorer access
    // Only cache experiment spans - regular logs don't need caching
    if (this.parentObjectType === SpanObjectTypeV3.EXPERIMENT) {
      const cachedSpan: CachedSpan = {
        input: partialRecord.input,
        output: partialRecord.output,
        expected: partialRecord.expected,
        error: partialRecord.error,
        scores: partialRecord.scores,
        metrics: partialRecord.metrics,
        metadata: partialRecord.metadata,
        tags: partialRecord.tags,
        span_id: this._spanId,
        span_parents: this._spanParents,
        is_root: !this._spanParents || this._spanParents.length === 0,
        span_attributes: partialRecord.span_attributes,
      };
      this._state.spanCache.queueWrite(
        this._rootSpanId,
        this._spanId,
        cachedSpan,
      );
    }

    const computeRecord = async () => {
      const record = {
        ...partialRecord,
        ...Object.fromEntries(
          await Promise.all(
            Object.entries(lazyInternalData).map(async ([key, value]) => [
              key,
              await value.get(),
            ]),
          ),
        ),
        ...new SpanComponentsV3({
          object_type: this.parentObjectType,
          object_id: await this.parentObjectId.get(),
        }).objectIdFields(),
      };
      // Customize inside the memoized lazy value, before attachment processing,
      // merging, and masking. Retries reuse the customized or stripped record.
      const customized = customizeSpanExport(record) as BackgroundLogEvent;
      // Background flushes run outside this span's context. Keep its policy on
      // the record without exposing internal metadata to customizers or JSON.
      Object.defineProperty(customized, CAPTURE_ATTACHMENTS, {
        value: this[CAPTURE_ATTACHMENTS],
        configurable: true,
      });
      return customized;
    };
    this._state.bgLogger().log([new LazyValue(computeRecord)]);
  }

  public logFeedback(event: Omit<LogFeedbackFullArgs, "id">): void {
    logFeedbackImpl(this._state, this.parentObjectType, this.parentObjectId, {
      ...event,
      id: this.id,
    });
  }

  public traced<R>(
    callback: (span: Span) => R,
    args?: StartSpanArgs & SetCurrentArg,
  ): R {
    const { setCurrent, ...argsRest } = args ?? {};
    const span = this.startSpan(argsRest);
    return runCatchFinally(
      () => {
        if (setCurrent ?? true) {
          return withCurrent(span, callback);
        } else {
          return callback(span);
        }
      },
      (error) => {
        logError(span, error);
        throw error;
      },
      () => span.end(),
    );
  }

  public startSpan(args?: StartSpanArgs): Span {
    const parentSpanIds: ParentSpanIds | undefined = args?.parent
      ? undefined
      : { spanId: this._spanId, rootSpanId: this._rootSpanId };
    return new SpanImpl({
      state: this._state,
      [CAPTURE_ATTACHMENTS]: this[CAPTURE_ATTACHMENTS],
      ...args,
      ...startSpanParentArgs({
        state: this._state,
        parent: args?.parent,
        parentObjectType: this.parentObjectType,
        parentObjectId: this.parentObjectId,
        parentComputeObjectMetadataArgs: this.parentComputeObjectMetadataArgs,
        parentSpanIds,
        propagatedEvent: args?.propagatedEvent ?? this.propagatedEvent,
        propagatedState: this._propagatedState,
      }),
    });
  }

  public startSpanWithParents(
    spanId: string,
    spanParents: string[],
    args?: StartSpanArgs,
  ): Span {
    const parentSpanIds: MultiParentSpanIds = {
      parentSpanIds: spanParents,
      rootSpanId: this._rootSpanId,
    };
    return new SpanImpl({
      state: this._state,
      [CAPTURE_ATTACHMENTS]: this[CAPTURE_ATTACHMENTS],
      ...args,
      ...startSpanParentArgs({
        state: this._state,
        parent: args?.parent,
        parentObjectType: this.parentObjectType,
        parentObjectId: this.parentObjectId,
        parentComputeObjectMetadataArgs: this.parentComputeObjectMetadataArgs,
        parentSpanIds,
        propagatedEvent: args?.propagatedEvent ?? this.propagatedEvent,
        propagatedState: this._propagatedState,
      }),
      spanId,
    });
  }

  public end(args?: EndSpanArgs): number {
    let endTime: number;
    let internalData: Partial<ExperimentEvent> = {};
    if (!this.loggedEndTime) {
      endTime = args?.endTime ?? getCurrentUnixTimestamp();
      internalData = { metrics: { end: endTime } };
    } else {
      endTime = this.loggedEndTime;
    }
    this.logInternal({ internalData });
    return endTime;
  }

  public async export(): Promise<string> {
    // Disable span cache since remote function spans won't be in the local cache
    this._state.spanCache.disable();

    return new (getSpanComponentsClass())({
      object_type: this.parentObjectType,

      ...(this.parentComputeObjectMetadataArgs &&
      !this.parentObjectId.hasSucceeded
        ? { compute_object_metadata_args: this.parentComputeObjectMetadataArgs }
        : { object_id: await this.parentObjectId.get() }),
      row_id: this.id,
      span_id: this._spanId,
      root_span_id: this._rootSpanId,
      propagated_event: this.propagatedEvent,
    }).toStr();
  }

  /**
   * Return this span's Braintrust parent string (`project_id:<id>`,
   * `project_name:<name>`, or `experiment_id:<id>`) for the `braintrust.parent`
   * baggage entry, or undefined when it cannot be determined synchronously.
   */
  public _getOtelParent(): string | undefined {
    if (this.parentObjectType === SpanObjectTypeV3.PROJECT_LOGS) {
      const id =
        this.parentComputeObjectMetadataArgs?.project_id ||
        this.parentObjectId.getSync().value;
      const name = this.parentComputeObjectMetadataArgs?.project_name;
      if (id) {
        return `project_id:${id}`;
      } else if (name) {
        return `project_name:${name}`;
      }
    } else if (this.parentObjectType === SpanObjectTypeV3.EXPERIMENT) {
      const id =
        this.parentComputeObjectMetadataArgs?.experiment_id ||
        this.parentObjectId.getSync().value;
      if (id) {
        return `experiment_id:${id}`;
      }
    }
    return undefined;
  }

  public inject(): Record<string, string>;
  public inject<T extends TraceContextCarrier>(carrier: T): T;
  public inject<T extends TraceContextCarrier>(
    carrier?: T,
  ): T | Record<string, string> {
    const resolvedCarrier = carrier ?? {};
    try {
      const braintrustParent =
        this._getOtelParent() ?? this._propagatedState?.braintrustParent;
      if (!braintrustParent) {
        // Symmetric with the receive-side warning in resolveW3cParent:
        // surface this in the process that caused it, rather than leaving the
        // consumer to debug a trace that arrived with no destination.
        debugLogger
          .forState(this._state)
          .warn(
            "Injecting trace context without braintrust.parent because the span's " +
              "destination is not available yet. The receiver will start a new " +
              "local trace instead of continuing this one.",
          );
      }
      _injectIntoCarrier(resolvedCarrier, {
        traceId: this._rootSpanId,
        spanId: this._spanId,
        braintrustParent,
        propagatedState: this._propagatedState,
      });
    } catch (e) {
      // best-effort: never break the caller
      debugLogger.warn(`Error injecting trace context: ${e}`);
    }
    return resolvedCarrier;
  }

  public async permalink(): Promise<string> {
    return await permalink(await this.export(), {
      state: this._state,
    });
  }

  public link(): string {
    if (!this.id) {
      return NOOP_SPAN_PERMALINK;
    }

    try {
      let baseUrl: string | null = null;

      if (this.parentObjectType === SpanObjectTypeV3.PROJECT_LOGS) {
        // For PROJECT_LOGS, use Logger's _getLinkBaseUrl which checks
        // state -> linkArgs -> env var (matches Python)
        const curLogger = this._state.currentLogger;
        if (curLogger) {
          baseUrl = curLogger._getLinkBaseUrl();
        }
      }

      // For EXPERIMENT or if Logger not available, fall back to state -> env var
      if (!baseUrl) {
        baseUrl = _getLinkBaseUrl(this._state);
        if (!baseUrl) {
          throw new Error("log-in-or-provide-org-name");
        }
      }

      return this._link(baseUrl);
    } catch (e) {
      return getErrPermlink(e instanceof Error ? e.message : String(e));
    }
  }

  _link(baseUrl: string): string {
    // NOTE[matt]: I believe lazy values should not exist in the span or the logger.
    // Nothing in this module should have the possibility of blocking with the lone exception of
    // flush() which should be a clear exception. We shouldn't build on it and
    // plan to remove it in the future.
    const args = this.parentComputeObjectMetadataArgs;

    switch (this.parentObjectType) {
      case SpanObjectTypeV3.PROJECT_LOGS: {
        // Links to spans require a project id or name. We might not either, so use whatever
        // we can to make a link without making a roundtrip to the server.
        const projectID =
          args?.project_id || this.parentObjectId.getSync().value;
        const projectName = args?.project_name;
        if (projectID) {
          return `${baseUrl}/object?object_type=project_logs&object_id=${projectID}&id=${this._id}`;
        } else if (projectName) {
          return `${baseUrl}/p/${projectName}/logs?oid=${this._id}`;
        } else {
          return getErrPermlink("provide-project-name-or-id");
        }
      }
      case SpanObjectTypeV3.EXPERIMENT: {
        // Experiment links require an id, so the sync version will only work after the experiment is
        // resolved.
        const expID =
          args?.experiment_id || this.parentObjectId?.getSync()?.value;
        if (!expID) {
          return getErrPermlink("provide-experiment-id");
        } else {
          return `${baseUrl}/object?object_type=experiment&object_id=${expID}&id=${this._id}`;
        }
      }
      case SpanObjectTypeV3.PLAYGROUND_LOGS: {
        // FIXME[matt] I dont believe these are used in the SDK.
        return NOOP_SPAN_PERMALINK;
      }
      default: {
        // trigger a compile-time error if we add a new object type
        const _exhaustive: never = this.parentObjectType;
        // eslint-disable-next-line no-unused-expressions
        _exhaustive;
        return NOOP_SPAN_PERMALINK;
      }
    }
  }

  async flush(): Promise<void> {
    return await this._state.bgLogger().flush();
  }

  public state(): BraintrustState {
    return this._state;
  }

  // Custom inspect for Node.js console.log
  static {
    Object.defineProperty(this.prototype, NODE_INSPECT_CUSTOM, {
      configurable: true,
      writable: true,
      value(this: SpanImpl): string {
        return `SpanImpl {
  kind: '${this.kind}',
  id: '${this.id}',
  spanId: '${this.spanId}',
  rootSpanId: '${this.rootSpanId}',
  spanParents: ${JSON.stringify(this.spanParents)}
}`;
      },
    });
  }

  // Custom toString
  toString(): string {
    return `SpanImpl(id=${this.id}, spanId=${this.spanId})`;
  }
}

function splitLoggingData({
  event,
  internalData,
}: {
  event?: ExperimentLogPartialArgs;
  // `internalData` contains fields that are not part of the "user-sanitized"
  // set of fields which we want to log in just one of the span rows.
  internalData?: Partial<ExperimentEvent>;
}): [Partial<typeof internalData>, Record<string, LazyValue<unknown>>] {
  // There should be no overlap between the dictionaries being merged,
  // except for `sanitized` and `internalData`, where the former overrides
  // the latter.
  const sanitized = validateAndSanitizeExperimentLogPartialArgs(event ?? {});

  const sanitizedAndInternalData: Partial<typeof internalData> &
    Partial<typeof sanitized> = {};
  mergeDicts(sanitizedAndInternalData, internalData || {});
  mergeDicts(sanitizedAndInternalData, sanitized);

  const serializableInternalData: typeof sanitizedAndInternalData = {};
  const lazyInternalData: Record<string, LazyValue<unknown>> = {};

  for (const [key, value] of Object.entries(sanitizedAndInternalData) as [
    keyof typeof sanitizedAndInternalData,
    any,
  ][]) {
    if (value instanceof BraintrustStream) {
      const streamCopy = value.copy();
      lazyInternalData[key] = new LazyValue(async () => {
        return await new Promise((resolve, reject) => {
          streamCopy
            .toReadableStream()
            .pipeThrough(createFinalValuePassThroughStream(resolve, reject))
            .pipeTo(devNullWritableStream());
        });
      });
    } else if (value instanceof ReadableStream) {
      lazyInternalData[key] = new LazyValue(async () => {
        return await new Promise((resolve, reject) => {
          value
            .pipeThrough(createFinalValuePassThroughStream(resolve, reject))
            .pipeTo(devNullWritableStream());
        });
      });
    } else {
      serializableInternalData[key] = value;
    }
  }

  return [serializableInternalData, lazyInternalData];
}

// Interface declarations preserve symbol methods with Oxc isolated emit.
export interface NoopSpan {
  [NODE_INSPECT_CUSTOM](): string;
}

export interface BraintrustState {
  [RESET_CONTEXT_MANAGER_STATE](): void;
  [NODE_INSPECT_CUSTOM](): string;
}

export interface HTTPConnection {
  [NODE_INSPECT_CUSTOM](): string;
}

export interface SpanImpl {
  [NODE_INSPECT_CUSTOM](): string;
  /** @internal Snapshot inherited by descendants and delayed instrumentation. */
  readonly [CAPTURE_ATTACHMENTS]: boolean;
}

export interface Logger {
  /** @internal */
  readonly [CAPTURE_ATTACHMENTS]: boolean;
}
