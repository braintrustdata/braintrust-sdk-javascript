/// <reference lib="dom" />

import { v4 as uuidv4 } from "uuid";

import { Queue, DEFAULT_QUEUE_SIZE } from "./queue";
import { IDGenerator, getIdGenerator } from "./id-gen";
import {
  _urljoin,
  AnyDatasetRecord,
  AUDIT_METADATA_FIELD,
  AUDIT_SOURCE_FIELD,
  BackgroundLogEvent,
  batchItems,
  constructJsonArray,
  DatasetRecord,
  DEFAULT_IS_LEGACY_DATASET,
  ensureDatasetRecord,
  ExperimentEvent,
  ExperimentLogFullArgs,
  ExperimentLogPartialArgs,
  IdField,
  IS_MERGE_FIELD,
  LogFeedbackFullArgs,
  mergeDicts,
  mergeGitMetadataSettings,
  mergeRowBatch,
  OBJECT_DELETE_FIELD,
  OBJECT_ID_KEYS,
  SanitizedExperimentLogPartialArgs,
  SpanComponentsV3,
  SpanComponentsV4,
  SpanObjectTypeV3,
  spanObjectTypeV3ToString,
  SpanType,
  SpanTypeAttribute,
  TRANSACTION_ID_FIELD,
  TransactionId,
  VALID_SOURCES,
  isArray,
  isObject,
  getObjValueByPath,
} from "./util";
import {
  type AnyModelParamsType as AnyModelParam,
  AttachmentReference as attachmentReferenceSchema,
  type AttachmentReferenceType as AttachmentReference,
  BraintrustAttachmentReference as BraintrustAttachmentReferenceSchema,
  type BraintrustAttachmentReferenceType as BraintrustAttachmentReference,
  BraintrustModelParams as braintrustModelParamsSchema,
  ChatCompletionTool as chatCompletionToolSchema,
  type ChatCompletionToolType as ChatCompletionTool,
  ExternalAttachmentReference as ExternalAttachmentReferenceSchema,
  type ExternalAttachmentReferenceType as ExternalAttachmentReference,
  type ModelParamsType as ModelParams,
  ResponseFormatJsonSchema as responseFormatJsonSchemaSchema,
  AttachmentStatus as attachmentStatusSchema,
  type AttachmentStatusType as AttachmentStatus,
  GitMetadataSettings as gitMetadataSettingsSchema,
  type GitMetadataSettingsType as GitMetadataSettings,
  type ChatCompletionMessageParamType as Message,
  type ChatCompletionOpenAIMessageParamType as OpenAIMessage,
  PromptData as promptDataSchema,
  type PromptDataType as PromptData,
  Prompt as promptSchema,
  type PromptType as PromptRow,
  type PromptSessionEventType as PromptSessionEvent,
  type RepoInfoType as RepoInfo,
  type PromptBlockDataType as PromptBlockData,
} from "./generated_types";

const BRAINTRUST_ATTACHMENT =
  BraintrustAttachmentReferenceSchema.shape.type.value;
const EXTERNAL_ATTACHMENT = ExternalAttachmentReferenceSchema.shape.type.value;
export const LOGS3_OVERFLOW_REFERENCE_TYPE = "logs3_overflow";
const BRAINTRUST_PARAMS = Object.keys(braintrustModelParamsSchema.shape);
// 6 MB for the AWS lambda gateway (from our own testing).
export const DEFAULT_MAX_REQUEST_SIZE = 6 * 1024 * 1024;

const parametersRowSchema = z.object({
  id: z.string().uuid(),
  _xact_id: z.string(),
  project_id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.union([z.string(), z.null()]).optional(),
  function_type: z.literal("parameters"),
  function_data: z.object({
    type: z.literal("parameters"),
    data: z.record(z.unknown()).optional(),
    __schema: z.record(z.unknown()),
  }),
  metadata: z
    .union([z.object({}).partial().passthrough(), z.null()])
    .optional(),
});
type ParametersRow = z.infer<typeof parametersRowSchema>;

import { waitUntil } from "@vercel/functions";
import {
  parseTemplateFormat,
  renderTemplateContent,
} from "./template/renderer";
import type { TemplateFormat } from "./template/registry";

import { z, ZodError } from "zod/v3";
import {
  BraintrustStream,
  createFinalValuePassThroughStream,
  devNullWritableStream,
} from "./functions/stream";
import iso, { IsoAsyncLocalStorage } from "./isomorph";
import { canUseDiskCache, DiskCache } from "./prompt-cache/disk-cache";
import { LRUCache } from "./prompt-cache/lru-cache";
import { PromptCache } from "./prompt-cache/prompt-cache";
import { ParametersCache } from "./prompt-cache/parameters-cache";
import {
  addAzureBlobHeaders,
  getCurrentUnixTimestamp,
  GLOBAL_PROJECT,
  isEmpty,
  LazyValue,
  SyncLazyValue,
  runCatchFinally,
} from "./util";
import { lintTemplate as _lintMustacheTemplate } from "./template/mustache-utils";
import { prettifyXact } from "../util/index";
import { SpanCache, CachedSpan } from "./span-cache";
import type { EvalParameters, InferParameters } from "./eval-parameters";

// Manual type definition for inline attachments (not in generated_types)
const InlineAttachmentReferenceSchema = z.object({
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

// Fields that should be passed to the masking function
// Note: "tags" field is intentionally excluded, but can be added if needed
const REDACTION_FIELDS = [
  "input",
  "output",
  "expected",
  "metadata",
  "context",
  "scores",
  "metrics",
] as const;

class MaskingError {
  constructor(
    public readonly fieldName: string,
    public readonly errorType: string,
  ) {}

  get errorMsg(): string {
    return `ERROR: Failed to mask field '${this.fieldName}' - ${this.errorType}`;
  }
}

/**
 * Apply masking function to data and handle errors gracefully.
 * If the masking function raises an exception, returns an error message.
 * Returns MaskingError for scores/metrics fields to signal they should be dropped.
 */
function applyMaskingToField(
  maskingFunction: (value: unknown) => unknown,
  data: unknown,
  fieldName: string,
): unknown {
  try {
    return maskingFunction(data);
  } catch (error) {
    // Return a generic error message without the stack trace to avoid leaking PII
    const errorType = error instanceof Error ? error.constructor.name : "Error";

    // For scores and metrics fields, return a special error object
    // to signal the field should be dropped and error logged
    if (fieldName === "scores" || fieldName === "metrics") {
      return new MaskingError(fieldName, errorType);
    }

    // For metadata field that expects object type, return an object with error key
    if (fieldName === "metadata") {
      return {
        error: `ERROR: Failed to mask field '${fieldName}' - ${errorType}`,
      };
    }

    // For other fields, return the error message as a string
    return `ERROR: Failed to mask field '${fieldName}' - ${errorType}`;
  }
}

export type SetCurrentArg = { setCurrent?: boolean };

type StartSpanEventArgs = ExperimentLogPartialArgs & Partial<IdField>;

export type StartSpanArgs = {
  name?: string;
  type?: SpanType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spanAttributes?: Record<any, any>;
  startTime?: number;
  parent?: string;
  event?: StartSpanEventArgs;
  propagatedEvent?: StartSpanEventArgs;
  spanId?: string;
  parentSpanIds?: ParentSpanIds | MultiParentSpanIds;
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
   * may change from time to time. If parsing is needed, use
   * `SpanComponentsV3.fromStr`.
   *
   * @returns Serialized representation of this span's identifiers.
   */
  export(): Promise<string>;

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
   * Alias for `end`.
   */
  close(args?: EndSpanArgs): number;

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

export abstract class ContextManager {
  abstract getParentSpanIds(): ContextParentSpanIds | undefined;
  abstract runInContext<R>(span: Span, callback: () => R): R;
  abstract getCurrentSpan(): Span | undefined;
}

class BraintrustContextManager extends ContextManager {
  private _currentSpan: IsoAsyncLocalStorage<Span>;

  constructor() {
    super();
    this._currentSpan = iso.newAsyncLocalStorage();
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

// make sure to update @braintrust/otel package
declare global {
  var BRAINTRUST_CONTEXT_MANAGER: (new () => ContextManager) | undefined;
  var BRAINTRUST_ID_GENERATOR: (new () => IDGenerator) | undefined;
  var BRAINTRUST_SPAN_COMPONENT: SpanComponent | undefined;
}

type SpanComponent = typeof SpanComponentsV3 | typeof SpanComponentsV4;

function getSpanComponentsClass(): SpanComponent {
  return globalThis.BRAINTRUST_SPAN_COMPONENT
    ? globalThis.BRAINTRUST_SPAN_COMPONENT
    : SpanComponentsV3;
}

export function getContextManager(): ContextManager {
  return globalThis.BRAINTRUST_CONTEXT_MANAGER
    ? new globalThis.BRAINTRUST_CONTEXT_MANAGER()
    : new BraintrustContextManager();
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

  public log(_: ExperimentLogPartialArgs) {}

  public logFeedback(_event: Omit<LogFeedbackFullArgs, "id">) {}

  public traced<R>(
    callback: (span: Span) => R,
    _1?: StartSpanArgs & SetCurrentArg,
  ): R {
    return callback(this);
  }

  public getParentInfo() {
    return undefined;
  }

  public startSpan(_1?: StartSpanArgs) {
    return this;
  }

  public end(args?: EndSpanArgs): number {
    return args?.endTime ?? getCurrentUnixTimestamp();
  }

  public async export(): Promise<string> {
    return "";
  }

  public async permalink(): Promise<string> {
    return NOOP_SPAN_PERMALINK;
  }

  public link(): string {
    return NOOP_SPAN_PERMALINK;
  }

  public async flush(): Promise<void> {}

  public close(args?: EndSpanArgs): number {
    return this.end(args);
  }

  public setAttributes(_args: Omit<StartSpanArgs, "event">) {}

  public startSpanWithParents(
    _spanId: string,
    _spanParents: string[],
    _args?: StartSpanArgs,
  ): Span {
    return this;
  }

  public state() {
    return _internalGetGlobalState();
  }

  // Custom inspect for Node.js console.log
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `NoopSpan {
  kind: '${this.kind}',
  id: '${this.id}',
  spanId: '${this.spanId}',
  rootSpanId: '${this.rootSpanId}',
  spanParents: ${JSON.stringify(this.spanParents)}
}`;
  }

  // Custom toString
  toString(): string {
    return `NoopSpan(id=${this.id}, spanId=${this.spanId})`;
  }
}

export const NOOP_SPAN = new NoopSpan();
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
});

export type SerializedBraintrustState = z.infer<typeof loginSchema>;

let stateNonce = 0;

export class BraintrustState {
  public id: string;
  public currentExperiment: Experiment | undefined;
  // Note: the value of IsAsyncFlush doesn't really matter here, since we
  // (safely) dynamically cast it whenever retrieving the logger.
  public currentLogger: Logger<false> | undefined;
  public currentParent: IsoAsyncLocalStorage<string>;
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

  public fetch: typeof globalThis.fetch = globalThis.fetch;
  private _appConn: HTTPConnection | null = null;
  private _apiConn: HTTPConnection | null = null;
  private _proxyConn: HTTPConnection | null = null;

  public promptCache: PromptCache;
  public parametersCache: ParametersCache;
  public spanCache: SpanCache;
  private _idGenerator: IDGenerator | null = null;
  private _contextManager: ContextManager | null = null;
  private _otelFlushCallback: (() => Promise<void>) | null = null;

  constructor(private loginParams: LoginOptions) {
    this.id = `${new Date().toLocaleString()}-${stateNonce++}`; // This is for debugging. uuidv4() breaks on platforms like Cloudflare.
    this.currentExperiment = undefined;
    this.currentLogger = undefined;
    this.currentParent = iso.newAsyncLocalStorage();
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

    this.resetLoginInfo();

    const memoryCache = new LRUCache<string, Prompt>({
      max: Number(iso.getEnv("BRAINTRUST_PROMPT_CACHE_MEMORY_MAX")) ?? 1 << 10,
    });
    const diskCache = canUseDiskCache()
      ? new DiskCache<Prompt>({
          cacheDir:
            iso.getEnv("BRAINTRUST_PROMPT_CACHE_DIR") ??
            `${iso.getEnv("HOME") ?? iso.homedir!()}/.braintrust/prompt_cache`,
          max:
            Number(iso.getEnv("BRAINTRUST_PROMPT_CACHE_DISK_MAX")) ?? 1 << 20,
        })
      : undefined;
    this.promptCache = new PromptCache({ memoryCache, diskCache });

    const parametersMemoryCache = new LRUCache<string, RemoteEvalParameters>({
      max:
        Number(iso.getEnv("BRAINTRUST_PARAMETERS_CACHE_MEMORY_MAX")) ?? 1 << 10,
    });
    const parametersDiskCache = canUseDiskCache()
      ? new DiskCache<RemoteEvalParameters>({
          cacheDir:
            iso.getEnv("BRAINTRUST_PARAMETERS_CACHE_DIR") ??
            `${iso.getEnv("HOME") ?? iso.homedir!()}/.braintrust/parameters_cache`,
          max:
            Number(iso.getEnv("BRAINTRUST_PARAMETERS_CACHE_DISK_MAX")) ??
            1 << 20,
        })
      : undefined;
    this.parametersCache = new ParametersCache({
      memoryCache: parametersMemoryCache,
      diskCache: parametersDiskCache,
    });

    this.spanCache = new SpanCache({ disabled: loginParams.disableSpanCache });
  }

  public resetLoginInfo() {
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
  }

  public resetIdGenState() {
    // Reset the ID generator so it gets recreated with current environment variables
    this._idGenerator = null;
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

  public copyLoginInfo(other: BraintrustState) {
    this.appUrl = other.appUrl;
    this.appPublicUrl = other.appPublicUrl;
    this.loginToken = other.loginToken;
    this.orgId = other.orgId;
    this.orgName = other.orgName;
    this.apiUrl = other.apiUrl;
    this.proxyUrl = other.proxyUrl;
    this.loggedIn = other.loggedIn;
    this.gitMetadataSettings = other.gitMetadataSettings;

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
    state.loginReplaceApiConn(state.apiConn());

    return state;
  }

  public setFetch(fetch: typeof globalThis.fetch) {
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

  public async login(loginParams: LoginOptions & { forceLogin?: boolean }) {
    if (this.apiUrl && !loginParams.forceLogin) {
      return;
    }
    const newState = await loginToState({
      ...this.loginParams,
      ...Object.fromEntries(
        Object.entries(loginParams).filter(([k, v]) => !isEmpty(v)),
      ),
    });
    this.copyLoginInfo(newState);
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
      this._proxyConn = new HTTPConnection(this.proxyUrl, this.fetch);
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

  public setOverrideBgLogger(logger: BackgroundLogger | null) {
    this._overrideBgLogger = logger;
  }

  // Should only be called by the login function.
  public loginReplaceApiConn(apiConn: HTTPConnection) {
    this._bgLogger.get().internalReplaceApiConn(apiConn);
  }

  public disable() {
    this._bgLogger.get().disable();
  }

  public enforceQueueSizeLimit(enforce: boolean) {
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
  [Symbol.for("nodejs.util.inspect.custom")](): string {
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
  }

  // Custom toString
  toString(): string {
    return `BraintrustState(id=${this.id}, org=${this.orgName || "none"}, loggedIn=${this.loggedIn})`;
  }
}

let _globalState: BraintrustState;

// Return a TestBackgroundLogger that will intercept logs before they are sent to the server.
// Used for testing only.
function useTestBackgroundLogger(): TestBackgroundLogger {
  const state = _internalGetGlobalState();
  if (!state) {
    throw new Error("global state not set yet");
  }

  const logger = new TestBackgroundLogger();
  state.setOverrideBgLogger(logger);
  return logger;
}

function clearTestBackgroundLogger() {
  _internalGetGlobalState()?.setOverrideBgLogger(null);
}

// Initialize a test Experiment without making network calls by injecting fake metadata.
// Useful for unit tests that need an Experiment instance.
function initTestExperiment(
  experimentName: string,
  projectName?: string,
): Experiment {
  setInitialTestState();
  const state = _internalGetGlobalState();
  const project = projectName ?? experimentName;

  const lazyMetadata: LazyValue<ProjectExperimentMetadata> = new LazyValue(
    async () => ({
      project: { id: project, name: project, fullInfo: {} },
      experiment: { id: experimentName, name: experimentName, fullInfo: {} },
    }),
  );

  return new Experiment(state, lazyMetadata);
}

/**
 * Initialize the global Braintrust state lazily, it only creates the BraintrustState instance on the first invocation.
 *
 * The state is stored in a global symbol to ensure cross-bundle compatibility.
 *
 * This is invoked by platform-specific initialization functions (configureNode/configureBrowser)
 *
 * @internal
 */
export function _internalSetInitialState() {
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
}
/**
 * @internal
 */
export const _internalGetGlobalState = () => _globalState;

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
  _globalState?.registerOtelFlush(callback);
  // Disable span cache since OTEL spans aren't in the local cache
  _globalState?.spanCache?.disable();
}

export class FailedHTTPResponse extends Error {
  public status: number;
  public text: string;
  public data: string;

  constructor(status: number, text: string, data: string) {
    super(`${status}: ${text} (${data})`);
    this.status = status;
    this.text = text;
    this.data = data;
  }
}

async function checkResponse(resp: Response) {
  if (resp.ok) {
    return resp;
  } else {
    throw new FailedHTTPResponse(
      resp.status,
      resp.statusText,
      await resp.text(),
    );
  }
}

class HTTPConnection {
  base_url: string;
  token: string | null;
  headers: Record<string, string>;
  fetch: typeof globalThis.fetch;

  constructor(base_url: string, fetch: typeof globalThis.fetch) {
    this.base_url = base_url;
    this.token = null;
    this.headers = {};

    this._reset();
    this.fetch = fetch;
  }

  public setFetch(fetch: typeof globalThis.fetch) {
    this.fetch = fetch;
  }

  async ping() {
    try {
      const resp = await this.get("ping");
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  make_long_lived() {
    // Following a suggestion in https://stackoverflow.com/questions/23013220/max-retries-exceeded-with-url-in-requests
    this._reset();
  }

  static sanitize_token(token: string) {
    return token.trim();
  }

  set_token(token: string) {
    token = HTTPConnection.sanitize_token(token);
    this.token = token;
    this._reset();
  }

  // As far as I can tell, you cannot set the retry/backoff factor here
  _reset() {
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
  ) {
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
    return await checkResponse(
      // Using toString() here makes it work with isomorphic fetch
      await this_fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          ...this_headers,
          ...headers,
        },
        keepalive: true,
        ...rest,
      }),
    );
  }

  async post(
    path: string,
    params?: Record<string, unknown> | string,
    config?: RequestInit,
  ) {
    const { headers, ...rest } = config || {};
    // On platforms like Cloudflare, we lose "this" when we make an async call,
    // so we need to bind it again.
    const this_fetch = this.fetch;
    const this_base_url = this.base_url;
    const this_headers = this.headers;

    return await checkResponse(
      await this_fetch(_urljoin(this_base_url, path), {
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
      }),
    );
  }

  async get_json(
    object_type: string,
    args: Record<string, string | string[] | undefined> | undefined = undefined,
    retries: number = 0,
  ) {
    const tries = retries + 1;
    for (let i = 0; i < tries; i++) {
      try {
        const resp = await this.get(`${object_type}`, args);
        return await resp.json();
      } catch (e) {
        if (i < tries - 1) {
          console.log(
            `Retrying API request ${object_type} ${JSON.stringify(args)} ${
              (e as any).status
            } ${(e as any).text}`,
          );
          continue;
        }
        throw e;
      }
    }
  }

  async post_json(
    object_type: string,
    args: Record<string, unknown> | string | undefined = undefined,
  ) {
    const resp = await this.post(`${object_type}`, args, {
      headers: { "Content-Type": "application/json" },
    });
    return await resp.json();
  }

  // Custom inspect for Node.js console.log
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `HTTPConnection {
  base_url: '${this.base_url}',
  token: '[REDACTED]'
}`;
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

interface ProjectExperimentMetadata {
  project: ObjectMetadata;
  experiment: ObjectMetadata;
}

interface ProjectDatasetMetadata {
  project: ObjectMetadata;
  dataset: ObjectMetadata;
}

interface OrgProjectMetadata {
  org_id: string;
  project: ObjectMetadata;
}

export interface LinkArgs {
  org_name?: string;
  app_url?: string;
  project_name?: string;
  project_id?: string;
}

export interface LogOptions<IsAsyncFlush> {
  asyncFlush?: IsAsyncFlush;
  computeMetadataArgs?: Record<string, any>;
  linkArgs?: LinkArgs;
}

export type PromiseUnless<B, R> = B extends true ? R : Promise<Awaited<R>>;

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
  async upload() {
    return await this.uploader.get();
  }

  /**
   * The attachment contents. This is a lazy value that will read the attachment contents from disk or memory on first access.
   */
  async data() {
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
    const doUpload = async (conn: HTTPConnection, orgId: string) => {
      const requestParams = {
        key: this.reference.key,
        filename: this.reference.filename,
        content_type: this.reference.content_type,
        org_id: orgId,
      };
      const [metadataPromiseResult, dataPromiseResult] =
        await Promise.allSettled([
          conn.post("/attachment", requestParams),
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
        objectStoreResponse = await checkResponse(
          await fetch(signedUrl, {
            method: "PUT" satisfies RequestInit["method"],
            headers,
            body: data,
          }),
        );
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

      const state = this.state ?? _globalState;
      await state.login({});

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
      const statusResponse = await conn.post(
        "/attachment/status",
        requestParams,
      );
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
      return new LazyValue(async () => new Blob([await readFile(data)]));
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
      console.warn(`Failed to read file: ${e}`);
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
  async upload() {
    return { upload_status: "done" as const };
  }

  /**
   * The attachment contents. This is a lazy value that will read the attachment contents from the external object store on first access.
   */
  async data() {
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

type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;

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
  async data() {
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
    const state = this.state ?? _globalState;
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

function logFeedbackImpl(
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
) {
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

function updateSpanImpl({
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

  const record = new LazyValue(async () => ({
    id,
    ...updateEvent,
    ...(await parentIds()),
    [IS_MERGE_FIELD]: true,
  }));
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
  const resolvedState = state ?? _globalState;
  const components = getSpanComponentsClass().fromStr(exported);

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

interface ParentSpanIds {
  spanId: string;
  rootSpanId: string;
}

interface MultiParentSpanIds {
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
    state ?? _globalState,
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

  const state = opts?.state ?? _globalState;
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
    const components = getSpanComponentsClass().fromStr(slug);
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
function startSpanParentArgs(args: {
  state: BraintrustState;
  parent: string | undefined;
  parentObjectType: SpanObjectTypeV3;
  parentObjectId: LazyValue<string>;
  parentComputeObjectMetadataArgs: Record<string, any> | undefined;
  parentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined;
  propagatedEvent: StartSpanEventArgs | undefined;
}): {
  parentObjectType: SpanObjectTypeV3;
  parentObjectId: LazyValue<string>;
  parentComputeObjectMetadataArgs: Record<string, any> | undefined;
  parentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined;
  propagatedEvent: StartSpanEventArgs | undefined;
} {
  let argParentObjectId: LazyValue<string> | undefined = undefined;
  let argParentSpanIds: ParentSpanIds | MultiParentSpanIds | undefined =
    undefined;
  let argPropagatedEvent: StartSpanEventArgs | undefined = undefined;
  if (args.parent) {
    if (args.parentSpanIds) {
      throw new Error("Cannot specify both parent and parentSpanIds");
    }
    const parentComponents = getSpanComponentsClass().fromStr(args.parent);
    if (args.parentObjectType !== parentComponents.data.object_type) {
      throw new Error(
        `Mismatch between expected span parent object type ${args.parentObjectType} and provided type ${parentComponents.data.object_type}`,
      );
    }

    const parentComponentsObjectIdLambda = spanComponentsToObjectIdLambda(
      args.state,
      parentComponents,
    );
    const computeParentObjectId = async () => {
      const parentComponentsObjectId = await parentComponentsObjectIdLambda();
      if ((await args.parentObjectId.get()) !== parentComponentsObjectId) {
        throw new Error(
          `Mismatch between expected span parent object id ${await args.parentObjectId.get()} and provided id ${parentComponentsObjectId}`,
        );
      }
      return await args.parentObjectId.get();
    };
    argParentObjectId = new LazyValue(computeParentObjectId);
    if (parentComponents.data.row_id) {
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
  } else {
    argParentObjectId = args.parentObjectId;
    argParentSpanIds = args.parentSpanIds;
    argPropagatedEvent = args.propagatedEvent;
  }

  return {
    parentObjectType: args.parentObjectType,
    parentObjectId: argParentObjectId,
    parentComputeObjectMetadataArgs: args.parentComputeObjectMetadataArgs,
    parentSpanIds: argParentSpanIds,
    propagatedEvent: argPropagatedEvent,
  };
}

export class Logger<IsAsyncFlush extends boolean> implements Exportable {
  private state: BraintrustState;
  private lazyMetadata: LazyValue<OrgProjectMetadata>;
  private _asyncFlush: IsAsyncFlush | undefined;
  private computeMetadataArgs: Record<string, any> | undefined;
  private _linkArgs: LinkArgs | undefined;
  private lastStartTime: number;
  private lazyId: LazyValue<string>;
  private calledStartSpan: boolean;

  // For type identification.
  public kind = "logger" as const;

  constructor(
    state: BraintrustState,
    lazyMetadata: LazyValue<OrgProjectMetadata>,
    logOptions: LogOptions<IsAsyncFlush> = {},
  ) {
    this.lazyMetadata = lazyMetadata;
    this._asyncFlush = logOptions.asyncFlush;
    this.computeMetadataArgs = logOptions.computeMetadataArgs;
    this._linkArgs = logOptions.linkArgs;
    this.lastStartTime = getCurrentUnixTimestamp();
    this.lazyId = new LazyValue(async () => await this.id);
    this.calledStartSpan = false;
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

  private parentObjectType() {
    return SpanObjectTypeV3.PROJECT_LOGS;
  }

  /**
   * Log a single event. The event will be batched and uploaded behind the scenes if `logOptions.asyncFlush` is true.
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
  ): PromiseUnless<IsAsyncFlush, string> {
    if (this.calledStartSpan && !options?.allowConcurrentWithSpans) {
      throw new Error(
        "Cannot run toplevel `log` method while using spans. To log to the span, call `logger.traced` and then log with `span.log`",
      );
    }

    const span = this.startSpanImpl({ startTime: this.lastStartTime, event });
    this.lastStartTime = span.end();
    const ret = span.id;
    type Ret = PromiseUnless<IsAsyncFlush, string>;
    if (this.asyncFlush === true) {
      return ret as Ret;
    } else {
      return (async () => {
        await this.flush();
        return ret;
      })() as Ret;
    }
  }

  /**
   * Create a new toplevel span underneath the logger. The name defaults to "root".
   *
   * See {@link Span.traced} for full details.
   */
  public traced<R>(
    callback: (span: Span) => R,
    args?: StartSpanArgs & SetCurrentArg,
  ): PromiseUnless<IsAsyncFlush, R> {
    const { setCurrent, ...argsRest } = args ?? {};
    const span = this.startSpan(argsRest);

    const ret = runCatchFinally(
      () => {
        if (setCurrent ?? true) {
          return withCurrent(span, callback);
        } else {
          return callback(span);
        }
      },
      (e) => {
        logError(span, e);
        throw e;
      },
      () => span.end(),
    );
    type Ret = PromiseUnless<IsAsyncFlush, R>;

    if (this.asyncFlush) {
      return ret as Ret;
    } else {
      return (async () => {
        const awaitedRet = await ret;
        await this.flush();
        return awaitedRet;
      })() as Ret;
    }
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

  get asyncFlush(): IsAsyncFlush | undefined {
    return this._asyncFlush;
  }

  /**
   * Return the base URL for links (e.g. https://braintrust.dev/app/my-org-name)
   * if we have the info, otherwise return null.
   * Resolution order: state -> linkArgs -> env var
   */
  public _getLinkBaseUrl(): string | null {
    return _getLinkBaseUrl(this.state, this._linkArgs);
  }
}

function castLogger<ToB extends boolean, FromB extends boolean>(
  logger: Logger<FromB> | undefined,
  asyncFlush?: ToB,
): Logger<ToB> | undefined {
  if (logger === undefined) return undefined;
  if (asyncFlush !== undefined && !!asyncFlush !== !!logger.asyncFlush) {
    throw new Error(
      `Asserted asyncFlush setting ${asyncFlush} does not match stored logger's setting ${logger.asyncFlush}`,
    );
  }
  return logger as unknown as Logger<ToB>;
}

export const logs3OverflowUploadSchema = z.object({
  method: z.enum(["PUT", "POST"]),
  signedUrl: z.string().url(),
  headers: z.record(z.string()).optional(),
  fields: z.record(z.string()).optional(),
  key: z.string().min(1),
});
export type Logs3OverflowUpload = z.infer<typeof logs3OverflowUploadSchema>;

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

export function constructLogs3OverflowRequest(key: string) {
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

export function utf8ByteLength(value: string) {
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

const DEFAULT_FLUSH_BACKPRESSURE_BYTES = 10 * 1024 * 1024; // 10 MB

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
  private maskingFunction: ((value: unknown) => unknown) | null = null;

  log(items: LazyValue<BackgroundLogEvent>[]): void {
    this.items.push(items);
  }

  setMaskingFunction(
    maskingFunction: ((value: unknown) => unknown) | null,
  ): void {
    this.maskingFunction = maskingFunction;
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

    let batch = mergeRowBatch(events);

    // Apply masking after merge, similar to HTTPBackgroundLogger
    if (this.maskingFunction) {
      batch = batch.map((item) => {
        const maskedItem = { ...item };

        // Only mask specific fields if they exist
        for (const field of REDACTION_FIELDS) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((item as any)[field] !== undefined) {
            const maskedValue = applyMaskingToField(
              this.maskingFunction!,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (item as any)[field],
              field,
            );
            if (maskedValue instanceof MaskingError) {
              // Drop the field and add error message
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              delete (maskedItem as any)[field];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if ((maskedItem as any).error) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (maskedItem as any).error =
                  `${(maskedItem as any).error}; ${maskedValue.errorMsg}`;
              } else {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (maskedItem as any).error = maskedValue.errorMsg;
              }
            } else {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (maskedItem as any)[field] = maskedValue;
            }
          }
        }

        return maskedItem as BackgroundLogEvent;
      });
    }

    return batch;
  }
}

const BACKGROUND_LOGGER_BASE_SLEEP_TIME_S = 1.0;

// We should only have one instance of this object per state object in
// 'BraintrustState._bgLogger'. Be careful about spawning multiple
// instances of this class, because concurrent BackgroundLoggers will not log to
// the backend in a deterministic order.
class HTTPBackgroundLogger implements BackgroundLogger {
  private apiConn: LazyValue<HTTPConnection>;
  private queue: Queue<LazyValue<BackgroundLogEvent>>;
  private activeFlush: Promise<void> = Promise.resolve();
  private activeFlushResolved = true;
  private activeFlushError: unknown = undefined;
  private onFlushError?: (error: unknown) => void;
  private maskingFunction: ((value: unknown) => unknown) | null = null;

  public syncFlush: boolean = false;
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

  private queueDropLoggingState = {
    numDropped: 0,
    lastLoggedTimestamp: 0,
  };

  constructor(apiConn: LazyValue<HTTPConnection>, opts?: BackgroundLoggerOpts) {
    opts = opts ?? {};
    this.apiConn = apiConn;

    const syncFlushEnv = Number(iso.getEnv("BRAINTRUST_SYNC_FLUSH"));
    if (!isNaN(syncFlushEnv)) {
      this.syncFlush = Boolean(syncFlushEnv);
    }

    const defaultBatchSizeEnv = Number(
      iso.getEnv("BRAINTRUST_DEFAULT_BATCH_SIZE"),
    );
    if (!isNaN(defaultBatchSizeEnv)) {
      this.defaultBatchSize = defaultBatchSizeEnv;
    }

    const maxRequestSizeEnv = Number(iso.getEnv("BRAINTRUST_MAX_REQUEST_SIZE"));
    if (!isNaN(maxRequestSizeEnv)) {
      this.maxRequestSizeOverride = maxRequestSizeEnv;
    }

    const numTriesEnv = Number(iso.getEnv("BRAINTRUST_NUM_RETRIES"));
    if (!isNaN(numTriesEnv)) {
      this.numTries = numTriesEnv + 1;
    }

    const queueDropExceedingMaxsizeEnv = Number(
      iso.getEnv("BRAINTRUST_QUEUE_DROP_EXCEEDING_MAXSIZE"),
    );

    if (!isNaN(queueDropExceedingMaxsizeEnv)) {
      this.queueDropExceedingMaxsize = queueDropExceedingMaxsizeEnv;
    }

    this.queue = new Queue(this.queueDropExceedingMaxsize);

    const queueDropLoggingPeriodEnv = Number(
      iso.getEnv("BRAINTRUST_QUEUE_DROP_LOGGING_PERIOD"),
    );
    if (!isNaN(queueDropLoggingPeriodEnv)) {
      this.queueDropLoggingPeriod = queueDropLoggingPeriodEnv;
    }

    if (iso.getEnv("BRAINTRUST_LOG_FLUSH_CHUNK_SIZE")) {
      console.warn(
        "BRAINTRUST_LOG_FLUSH_CHUNK_SIZE is deprecated and no longer has any effect. " +
          "Log flushing now sends all items at once and batches them automatically. " +
          "This environment variable will be removed in a future major release.",
      );
    }

    const flushBackpressureBytesEnv = Number(
      iso.getEnv("BRAINTRUST_FLUSH_BACKPRESSURE_BYTES"),
    );
    if (!isNaN(flushBackpressureBytesEnv) && flushBackpressureBytesEnv > 0) {
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
    this.onFlushError = opts.onFlushError;
  }

  setMaskingFunction(
    maskingFunction: ((value: unknown) => unknown) | null,
  ): void {
    this.maskingFunction = maskingFunction;
  }

  pendingFlushBytes(): number {
    return this._pendingBytes;
  }

  flushBackpressureBytes(): number {
    return this._flushBackpressureBytes;
  }

  log(items: LazyValue<BackgroundLogEvent>[]) {
    if (this._disabled) {
      return;
    }

    const droppedItems = this.queue.push(...items);

    if (!this.syncFlush) {
      this.triggerActiveFlush();
    }

    if (droppedItems.length) {
      this.registerDroppedItemCount(droppedItems.length);
      if (this.allPublishPayloadsDir || this.failedPublishPayloadsDir) {
        this.dumpDroppedEvents(droppedItems);
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
          console.warn("Failed to fetch version info for payload limit:", e);
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
    if (this.syncFlush) {
      this.triggerActiveFlush();
    }
    await this.activeFlush;
    if (this.activeFlushError) {
      const err = this.activeFlushError;
      this.activeFlushError = undefined;
      if (this.syncFlush) {
        throw err;
      }
    }
  }

  private async flushOnce(args?: { batchSize?: number }): Promise<void> {
    if (this._disabled) {
      this.queue.clear();
      return;
    }

    const batchSize = args?.batchSize ?? this.defaultBatchSize;

    // Drain the queue.
    const wrappedItems = this.queue.drain();

    if (wrappedItems.length === 0) {
      return;
    }

    await this.flushWrappedItemsChunk(wrappedItems, batchSize);

    // If more items were added while we were flushing, flush again
    if (this.queue.length() > 0) {
      await this.flushOnce(args);
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
    if (allItems.length === 0) {
      return;
    }

    // Construct batches of records to flush in parallel.
    let chunkBytes = 0;
    const allItemsWithMeta = allItems.map((item) => {
      const withMeta = stringifyWithOverflowMeta(item);
      chunkBytes += withMeta.str.length;
      return withMeta;
    });
    this._pendingBytes += chunkBytes;

    const maxRequestSizeResult = await this.getMaxRequestSize();
    const batches = batchItems({
      items: allItemsWithMeta,
      batchMaxNumItems: batchSize,
      batchMaxNumBytes: maxRequestSizeResult.maxRequestSize / 2,
      getByteSize: (item) => item.str.length,
    });

    const postPromises = batches.map((batch) =>
      (async () => {
        try {
          await this.submitLogsRequest(batch, maxRequestSizeResult);
          return { type: "success" } as const;
        } catch (e) {
          return { type: "error", value: e } as const;
        }
      })(),
    );
    const results = await Promise.all(postPromises);
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
  ): Promise<[BackgroundLogEvent[], Attachment[]]> {
    for (let i = 0; i < this.numTries; ++i) {
      try {
        const items = await Promise.all(wrappedItems.map((x) => x.get()));

        // TODO(kevin): `extractAttachments` should ideally come after
        // `mergeRowBatch`, since merge-overwriting could result in some
        // attachments that no longer need to be uploaded. This would require
        // modifying the merge logic to treat the Attachment object as a "leaf"
        // rather than attempting to merge the keys of the Attachment.
        const attachments: Attachment[] = [];
        items.forEach((item) => extractAttachments(item, attachments));

        let mergedItems = mergeRowBatch(items);

        // Apply masking after merge but before sending to backend
        if (this.maskingFunction) {
          mergedItems = mergedItems.map((item) => {
            const maskedItem = { ...item };

            // Only mask specific fields if they exist
            for (const field of REDACTION_FIELDS) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if ((item as any)[field] !== undefined) {
                const maskedValue = applyMaskingToField(
                  this.maskingFunction!,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (item as any)[field],
                  field,
                );
                if (maskedValue instanceof MaskingError) {
                  // Drop the field and add error message
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  delete (maskedItem as any)[field];
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  if ((maskedItem as any).error) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (maskedItem as any).error =
                      `${(maskedItem as any).error}; ${maskedValue.errorMsg}`;
                  } else {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (maskedItem as any).error = maskedValue.errorMsg;
                  }
                } else {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (maskedItem as any)[field] = maskedValue;
                }
              }
            }

            return maskedItem as BackgroundLogEvent;
          });
        }

        return [mergedItems, attachments];
      } catch (e) {
        let errmsg = "Encountered error when constructing records to flush";
        const isRetrying = i + 1 < this.numTries;
        if (isRetrying) {
          errmsg += ". Retrying";
        }

        console.warn(errmsg);
        if (!isRetrying) {
          console.warn(
            `Failed to construct log records to flush after ${this.numTries} attempts. Dropping batch`,
          );
          throw e;
        } else {
          console.warn(e);
          const sleepTimeS = BACKGROUND_LOGGER_BASE_SLEEP_TIME_S * 2 ** i;
          console.info(`Sleeping for ${sleepTimeS}s`);
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
        console.warn(
          `log request failed after ${this.numTries} retries. Dropping batch`,
        );
        throw new Error(errMsg);
      } else {
        console.warn(errMsg);
        if (isRetrying) {
          const sleepTimeS = BACKGROUND_LOGGER_BASE_SLEEP_TIME_S * 2 ** i;
          console.info(`Sleeping for ${sleepTimeS}s`);
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
      console.warn(
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
        allItems.map((x) => stringifyWithOverflowMeta(x)),
      );
      const attachmentStr = JSON.stringify(
        allAttachments.map((a) => a.debugInfo()),
      );

      const payload = `{"data": ${dataStr}, "attachments": ${attachmentStr}}\n`;

      for (const payloadDir of publishPayloadsDir) {
        await HTTPBackgroundLogger.writePayloadToDir({ payloadDir, payload });
      }
    } catch (e) {
      console.error(e);
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
      console.warn(
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
      console.error(
        `Failed to write failed payload to output file ${payloadFile}:\n`,
        e,
      );
    }
  }

  private triggerActiveFlush() {
    if (this.activeFlushResolved) {
      this.activeFlushResolved = false;
      this.activeFlushError = undefined;
      this.activeFlush = (async () => {
        try {
          await this.flushOnce();
        } catch (err) {
          if (err instanceof AggregateError) {
            for (const e of err.errors) {
              this.onFlushError?.(e);
            }
          } else {
            this.onFlushError?.(err);
          }

          this.activeFlushError = err;
        } finally {
          this.activeFlushResolved = true;
        }
      })();

      waitUntil(this.activeFlush);
    }
  }

  private logFailedPayloadsDir() {
    console.warn(`Logging failed payloads to ${this.failedPublishPayloadsDir}`);
  }

  // Should only be called by BraintrustState.
  public internalReplaceApiConn(apiConn: HTTPConnection) {
    this.apiConn = new LazyValue(async () => apiConn);
  }

  public disable() {
    this._disabled = true;
  }

  public enforceQueueSizeLimit(enforce: boolean) {
    this.queue.enforceQueueSizeLimit(enforce);
  }
}

type InitOpenOption<IsOpen extends boolean> = {
  open?: IsOpen;
};

/**
 * Reference to a dataset by ID and optional version.
 */
export interface DatasetRef {
  id: string;
  version?: string;
}

export type InitOptions<IsOpen extends boolean> = FullLoginOptions & {
  experiment?: string;
  description?: string;
  dataset?: AnyDataset | DatasetRef;
  update?: boolean;
  baseExperiment?: string;
  isPublic?: boolean;
  metadata?: Record<string, unknown>;
  tags?: string[];
  gitMetadataSettings?: GitMetadataSettings;
  projectId?: string;
  baseExperimentId?: string;
  repoInfo?: RepoInfo;
  setCurrent?: boolean;
  state?: BraintrustState;
} & InitOpenOption<IsOpen>;

export type FullInitOptions<IsOpen extends boolean> = {
  project?: string;
} & InitOptions<IsOpen>;

type InitializedExperiment<IsOpen extends boolean | undefined> =
  IsOpen extends true ? ReadonlyExperiment : Experiment;

/**
 * Log in, and then initialize a new experiment in a specified project. If the project does not exist, it will be created.
 *
 * @param options Options for configuring init().
 * @param options.project The name of the project to create the experiment in. Must specify at least one of `project` or `projectId`.
 * @param options.experiment The name of the experiment to create. If not specified, a name will be generated automatically.
 * @param options.description An optional description of the experiment.
 * @param options.dataset (Optional) A dataset to associate with the experiment. You can pass in the name of the dataset (in the same project) or a dataset object (from any project).
 * @param options.update If the experiment already exists, continue logging to it. If it does not exist, creates the experiment with the specified arguments.
 * @param options.baseExperiment An optional experiment name to use as a base. If specified, the new experiment will be summarized and compared to this experiment. Otherwise, it will pick an experiment by finding the closest ancestor on the default (e.g. main) branch.
 * @param options.isPublic An optional parameter to control whether the experiment is publicly visible to anybody with the link or privately visible to only members of the organization. Defaults to private.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. If no API key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @param options.metadata (Optional) A dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings.
 * @param options.gitMetadataSettings (Optional) Settings for collecting git metadata. By default, will collect all git metadata fields allowed in org-level settings.
 * @param setCurrent If true (the default), set the global current-experiment to the newly-created one.
 * @param options.open If the experiment already exists, open it in read-only mode. Throws an error if the experiment does not already exist.
 * @param options.projectId The id of the project to create the experiment in. This takes precedence over `project` if specified.
 * @param options.baseExperimentId An optional experiment id to use as a base. If specified, the new experiment will be summarized and compared to this. This takes precedence over `baseExperiment` if specified.
 * @param options.repoInfo (Optional) Explicitly specify the git metadata for this experiment. This takes precedence over `gitMetadataSettings` if specified.
 * @param options.tags (Optional) A list of tags to attach to the experiment.
 * @returns The newly created Experiment.
 */
export function init<IsOpen extends boolean = false>(
  options: Readonly<FullInitOptions<IsOpen>>,
): InitializedExperiment<IsOpen>;

/**
 * Legacy form of `init` which accepts the project name as the first parameter,
 * separately from the remaining options. See `init(options)` for full details.
 */
export function init<IsOpen extends boolean = false>(
  project: string,
  options?: Readonly<InitOptions<IsOpen>>,
): InitializedExperiment<IsOpen>;

/**
 * Combined overload implementation of `init`. Do not call this directly.
 * Instead, call `init(options)` or `init(project, options)`.
 */
export function init<IsOpen extends boolean = false>(
  projectOrOptions: string | Readonly<FullInitOptions<IsOpen>>,
  optionalOptions?: Readonly<InitOptions<IsOpen>>,
): InitializedExperiment<IsOpen> {
  const options = ((): Readonly<FullInitOptions<IsOpen>> => {
    if (typeof projectOrOptions === "string") {
      return { ...optionalOptions, project: projectOrOptions };
    } else {
      if (optionalOptions !== undefined) {
        throw new Error(
          "Cannot specify options struct as both parameters. Must call either init(project, options) or init(options).",
        );
      }
      return projectOrOptions;
    }
  })();

  const {
    project,
    experiment,
    description,
    dataset,
    baseExperiment,
    isPublic,
    open,
    update,
    appUrl,
    apiKey,
    orgName,
    forceLogin,
    fetch,
    metadata,
    tags,
    gitMetadataSettings,
    projectId,
    baseExperimentId,
    repoInfo,
    state: stateArg,
  } = options;

  if (!project && !projectId) {
    throw new Error("Must specify at least one of project or projectId");
  }

  if (open && update) {
    throw new Error("Cannot open and update an experiment at the same time");
  }

  const state = stateArg ?? _globalState;

  // Ensure unlimited queue for init() calls (experiments)
  // Experiments should never drop data
  state.enforceQueueSizeLimit(false);

  if (open) {
    if (isEmpty(experiment)) {
      throw new Error(`Cannot open an experiment without specifying its name`);
    }

    const lazyMetadata: LazyValue<ProjectExperimentMetadata> = new LazyValue(
      async () => {
        await state.login({ apiKey, appUrl, orgName, fetch, forceLogin });
        const args: Record<string, unknown> = {
          project_name: project,
          project_id: projectId,
          org_name: state.orgName,
          experiment_name: experiment,
        };

        const response = await state
          .appConn()
          .post_json("api/experiment/get", args);

        if (response.length === 0) {
          throw new Error(
            `Experiment ${experiment} not found in project ${
              projectId ?? project
            }.`,
          );
        }

        const info = response[0];
        return {
          project: {
            id: info.project_id,
            name: project ?? "UNKNOWN_PROJECT",
            fullInfo: {},
          },
          experiment: {
            id: info.id,
            name: info.name,
            fullInfo: info,
          },
        };
      },
    );

    return new ReadonlyExperiment(
      stateArg ?? _globalState,
      lazyMetadata,
    ) as InitializedExperiment<IsOpen>;
  }

  const lazyMetadata: LazyValue<ProjectExperimentMetadata> = new LazyValue(
    async () => {
      await state.login({ apiKey, appUrl, orgName });
      const args: Record<string, unknown> = {
        project_name: project,
        project_id: projectId,
        org_id: state.orgId,
        update,
      };

      if (experiment) {
        args["experiment_name"] = experiment;
      }

      if (description) {
        args["description"] = description;
      }

      const repoInfoArg = await (async (): Promise<RepoInfo | undefined> => {
        if (repoInfo) {
          return repoInfo;
        }
        let mergedGitMetadataSettings = {
          ...(state.gitMetadataSettings || {
            collect: "all",
          }),
        };
        if (gitMetadataSettings) {
          mergedGitMetadataSettings = mergeGitMetadataSettings(
            mergedGitMetadataSettings,
            gitMetadataSettings,
          );
        }
        return await iso.getRepoInfo(mergedGitMetadataSettings);
      })();

      if (repoInfoArg) {
        args["repo_info"] = repoInfoArg;
      }

      if (baseExperimentId) {
        args["base_exp_id"] = baseExperimentId;
      } else if (baseExperiment) {
        args["base_experiment"] = baseExperiment;
      } else {
        args["ancestor_commits"] = await iso.getPastNAncestors();
      }

      if (dataset !== undefined) {
        if (
          "id" in dataset &&
          typeof dataset.id === "string" &&
          !("__braintrust_dataset_marker" in dataset)
        ) {
          // Simple {id: ..., version?: ...} object
          args["dataset_id"] = dataset.id;
          if ("version" in dataset && dataset.version !== undefined) {
            args["dataset_version"] = dataset.version;
          }
        } else {
          // Full Dataset object
          args["dataset_id"] = await (dataset as AnyDataset).id;
          args["dataset_version"] = await (dataset as AnyDataset).version();
        }
      }

      if (isPublic !== undefined) {
        args["public"] = isPublic;
      }

      if (metadata) {
        args["metadata"] = metadata;
      }

      if (tags) {
        validateTags(tags);
        args["tags"] = tags;
      }

      let response = null;
      while (true) {
        try {
          response = await state
            .appConn()
            .post_json("api/experiment/register", args);
          break;
        } catch (e: any) {
          if (
            args["base_experiment"] &&
            `${"data" in e && e.data}`.includes("base experiment")
          ) {
            console.warn(
              `Base experiment ${args["base_experiment"]} not found.`,
            );
            delete args["base_experiment"];
          } else {
            throw e;
          }
        }
      }

      return {
        project: {
          id: response.project.id,
          name: response.project.name,
          fullInfo: response.project,
        },
        experiment: {
          id: response.experiment.id,
          name: response.experiment.name,
          created: response.experiment.created,
          fullInfo: response.experiment,
        },
      };
    },
  );

  const ret = new Experiment(
    state,
    lazyMetadata,
    dataset !== undefined && "version" in dataset
      ? (dataset as AnyDataset)
      : undefined,
  );
  if (options.setCurrent ?? true) {
    state.currentExperiment = ret;
  }
  return ret as InitializedExperiment<IsOpen>;
}

/**
 * Alias for init(options).
 */
export function initExperiment<IsOpen extends boolean = false>(
  options: Readonly<InitOptions<IsOpen>>,
): InitializedExperiment<IsOpen>;

/**
 * Alias for init(project, options).
 */
export function initExperiment<IsOpen extends boolean = false>(
  project: string,
  options?: Readonly<InitOptions<IsOpen>>,
): InitializedExperiment<IsOpen>;

/**
 * Combined overload implementation of `initExperiment`, which is an alias for
 * `init`. Do not call this directly. Instead, call `initExperiment(options)` or
 * `initExperiment(project, options)`.
 */
export function initExperiment<IsOpen extends boolean = false>(
  projectOrOptions: string | Readonly<InitOptions<IsOpen>>,
  optionalOptions?: Readonly<InitOptions<IsOpen>>,
): InitializedExperiment<IsOpen> {
  const options = ((): Readonly<FullInitOptions<IsOpen>> => {
    if (typeof projectOrOptions === "string") {
      return { ...optionalOptions, project: projectOrOptions };
    } else {
      if (optionalOptions !== undefined) {
        throw new Error(
          "Cannot specify options struct as both parameters. Must call either init(project, options) or init(options).",
        );
      }
      return projectOrOptions;
    }
  })();
  return init(options);
}

/**
 * @deprecated Use {@link init} instead.
 */
export function withExperiment<R>(
  project: string,
  callback: (experiment: Experiment) => R,
  options: Readonly<InitOptions<false> & SetCurrentArg> = {},
): R {
  console.warn(
    "withExperiment is deprecated and will be removed in a future version of braintrust. Simply create the experiment with `init`.",
  );
  const experiment = init(project, options);
  return callback(experiment);
}

/**
 * @deprecated Use {@link initLogger} instead.
 */
export function withLogger<IsAsyncFlush extends boolean = false, R = void>(
  callback: (logger: Logger<IsAsyncFlush>) => R,
  options: Readonly<InitLoggerOptions<IsAsyncFlush> & SetCurrentArg> = {},
): R {
  console.warn(
    "withLogger is deprecated and will be removed in a future version of braintrust. Simply create the logger with `initLogger`.",
  );
  const logger = initLogger(options);
  return callback(logger);
}

type UseOutputOption<IsLegacyDataset extends boolean> = {
  useOutput?: IsLegacyDataset;
};

export type InitDatasetOptions<IsLegacyDataset extends boolean> =
  FullLoginOptions & {
    dataset?: string;
    description?: string;
    version?: string;
    projectId?: string;
    metadata?: Record<string, unknown>;
    state?: BraintrustState;
    _internal_btql?: Record<string, unknown>;
  } & UseOutputOption<IsLegacyDataset>;

export type FullInitDatasetOptions<IsLegacyDataset extends boolean> = {
  project?: string;
} & InitDatasetOptions<IsLegacyDataset>;

/**
 * Create a new dataset in a specified project. If the project does not exist, it will be created.
 *
 * @param options Options for configuring initDataset().
 * @param options.project The name of the project to create the dataset in. Must specify at least one of `project` or `projectId`.
 * @param options.dataset The name of the dataset to create. If not specified, a name will be generated automatically.
 * @param options.description An optional description of the dataset.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. If no API key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @param options.projectId The id of the project to create the dataset in. This takes precedence over `project` if specified.
 * @param options.metadata A dictionary with additional data about the dataset. The values in `metadata` can be any JSON-serializable type, but its keys must be strings.
 * @param options.useOutput (Deprecated) If true, records will be fetched from this dataset in the legacy format, with the "expected" field renamed to "output". This option will be removed in a future version of Braintrust.
 * @returns The newly created Dataset.
 */
export function initDataset<
  IsLegacyDataset extends boolean = typeof DEFAULT_IS_LEGACY_DATASET,
>(
  options: Readonly<FullInitDatasetOptions<IsLegacyDataset>>,
): Dataset<IsLegacyDataset>;

/**
 * Legacy form of `initDataset` which accepts the project name as the first
 * parameter, separately from the remaining options.
 *
 * See `initDataset(options)` for full details.
 */
export function initDataset<
  IsLegacyDataset extends boolean = typeof DEFAULT_IS_LEGACY_DATASET,
>(
  project: string,
  options?: Readonly<InitDatasetOptions<IsLegacyDataset>>,
): Dataset<IsLegacyDataset>;

/**
 * Combined overload implementation of `initDataset`. Do not call this
 * directly. Instead, call `initDataset(options)` or `initDataset(project,
 * options)`.
 */
export function initDataset<
  IsLegacyDataset extends boolean = typeof DEFAULT_IS_LEGACY_DATASET,
>(
  projectOrOptions: string | Readonly<FullInitDatasetOptions<IsLegacyDataset>>,
  optionalOptions?: Readonly<InitDatasetOptions<IsLegacyDataset>>,
): Dataset<IsLegacyDataset> {
  const options = ((): Readonly<FullInitDatasetOptions<IsLegacyDataset>> => {
    if (typeof projectOrOptions === "string") {
      return { ...optionalOptions, project: projectOrOptions };
    } else {
      if (optionalOptions !== undefined) {
        throw new Error(
          "Cannot specify options struct as both parameters. Must call either initDataset(project, options) or initDataset(options).",
        );
      }
      return projectOrOptions;
    }
  })();

  const {
    project,
    dataset,
    description,
    version,
    appUrl,
    apiKey,
    orgName,
    fetch,
    forceLogin,
    projectId,
    metadata,
    useOutput: legacy,
    state: stateArg,
    _internal_btql,
  } = options;

  const state = stateArg ?? _globalState;

  const lazyMetadata: LazyValue<ProjectDatasetMetadata> = new LazyValue(
    async () => {
      await state.login({
        orgName,
        apiKey,
        appUrl,
        fetch,
        forceLogin,
      });

      const args: Record<string, unknown> = {
        org_id: state.orgId,
        project_name: project,
        project_id: projectId,
        dataset_name: dataset,
        description,
        metadata,
      };
      const response = await state
        .appConn()
        .post_json("api/dataset/register", args);

      return {
        project: {
          id: response.project.id,
          name: response.project.name,
          fullInfo: response.project,
        },
        dataset: {
          id: response.dataset.id,
          name: response.dataset.name,
          fullInfo: response.dataset,
        },
      };
    },
  );

  return new Dataset(
    stateArg ?? _globalState,
    lazyMetadata,
    version,
    legacy,
    _internal_btql,
  );
}

/**
 * @deprecated Use {@link initDataset} instead.
 */
export function withDataset<
  R,
  IsLegacyDataset extends boolean = typeof DEFAULT_IS_LEGACY_DATASET,
>(
  project: string,
  callback: (dataset: Dataset<IsLegacyDataset>) => R,
  options: Readonly<InitDatasetOptions<IsLegacyDataset>> = {},
): R {
  console.warn(
    "withDataset is deprecated and will be removed in a future version of braintrust. Simply create the dataset with `initDataset`.",
  );
  const dataset = initDataset<IsLegacyDataset>(project, options);
  return callback(dataset);
}

// Note: the argument names *must* serialize the same way as the argument names
// for the corresponding python function, because this function may be invoked
// from arguments serialized elsewhere.
async function computeLoggerMetadata(
  state: BraintrustState,
  {
    project_name,
    project_id,
  }: {
    project_name?: string;
    project_id?: string;
  },
) {
  await state.login({});
  const org_id = state.orgId!;
  if (isEmpty(project_id)) {
    const response = await state.appConn().post_json("api/project/register", {
      project_name: project_name || GLOBAL_PROJECT,
      org_id,
    });
    return {
      org_id,
      project: {
        id: response.project.id,
        name: response.project.name,
        fullInfo: response.project,
      },
    };
  } else if (isEmpty(project_name)) {
    const response = await state.appConn().get_json("api/project", {
      id: project_id,
    });
    return {
      org_id,
      project: {
        id: project_id,
        name: response.name,
        fullInfo: response.project,
      },
    };
  } else {
    return {
      org_id,
      project: { id: project_id, name: project_name, fullInfo: {} },
    };
  }
}

type AsyncFlushArg<IsAsyncFlush> = {
  asyncFlush?: IsAsyncFlush;
};

export type InitLoggerOptions<IsAsyncFlush> = FullLoginOptions & {
  projectName?: string;
  projectId?: string;
  setCurrent?: boolean;
  state?: BraintrustState;
  orgProjectMetadata?: OrgProjectMetadata;
} & AsyncFlushArg<IsAsyncFlush>;

/**
 * Create a new logger in a specified project. If the project does not exist, it will be created.
 *
 * @param options Additional options for configuring init().
 * @param options.projectName The name of the project to log into. If unspecified, will default to the Global project.
 * @param options.projectId The id of the project to log into. This takes precedence over projectName if specified.
 * @param options.asyncFlush If true, will log asynchronously in the background. Otherwise, will log synchronously. (true by default)
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. If no API
 * key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @param options.forceLogin Login again, even if you have already logged in (by default, the logger will not login if you are already logged in)
 * @param setCurrent If true (the default), set the global current-experiment to the newly-created one.
 * @returns The newly created Logger.
 */
export function initLogger<IsAsyncFlush extends boolean = true>(
  options: Readonly<InitLoggerOptions<IsAsyncFlush>> = {},
) {
  const {
    projectName,
    projectId,
    asyncFlush: asyncFlushArg,
    appUrl,
    apiKey,
    orgName,
    forceLogin,
    fetch,
    state: stateArg,
  } = options || {};

  const asyncFlush =
    asyncFlushArg === undefined ? (true as IsAsyncFlush) : asyncFlushArg;

  const computeMetadataArgs = {
    project_name: projectName,
    project_id: projectId,
  };

  const linkArgs = {
    org_name: orgName,
    app_url: appUrl,
    project_name: projectName,
    project_id: projectId,
  };

  const state = stateArg ?? _globalState;

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

  const ret = new Logger<IsAsyncFlush>(state, lazyMetadata, {
    asyncFlush,
    computeMetadataArgs,
    linkArgs,
  });
  if (options.setCurrent ?? true) {
    state.currentLogger = ret as Logger<false>;
  }
  return ret;
}

export type LoadPromptOptions = FullLoginOptions & {
  projectName?: string;
  projectId?: string;
  slug?: string;
  version?: string;
  id?: string;
  defaults?: DefaultPromptArgs;
  noTrace?: boolean;
  environment?: string;
  state?: BraintrustState;
};

type LoadParametersBaseOptions = FullLoginOptions & {
  state?: BraintrustState;
};

export type LoadParametersByIdOptions = LoadParametersBaseOptions & {
  id: string;
  version?: string;
};

export type LoadParametersByIdWithEnvOptions = LoadParametersBaseOptions & {
  id: string;
  environment: string;
};

export type LoadParametersByProjectNameOptions = LoadParametersBaseOptions & {
  projectName: string;
  slug: string;
  version?: string;
};

export type LoadParametersByProjectNameWithEnvOptions =
  LoadParametersBaseOptions & {
    projectName: string;
    slug: string;
    environment: string;
  };

export type LoadParametersByProjectIdOptions = LoadParametersBaseOptions & {
  projectId: string;
  slug: string;
  version?: string;
};

export type LoadParametersByProjectIdWithEnvOptions =
  LoadParametersBaseOptions & {
    projectId: string;
    slug: string;
    environment: string;
  };

export type LoadParametersOptions =
  | LoadParametersByIdOptions
  | LoadParametersByIdWithEnvOptions
  | LoadParametersByProjectNameOptions
  | LoadParametersByProjectNameWithEnvOptions
  | LoadParametersByProjectIdOptions
  | LoadParametersByProjectIdWithEnvOptions;

type LoadParametersImplementationOptions = LoadParametersBaseOptions & {
  projectName?: string;
  projectId?: string;
  slug?: string;
  version?: string;
  id?: string;
  environment?: string;
};

/**
 * Load a prompt from the specified project.
 *
 * @param options Options for configuring loadPrompt().
 * @param options.projectName The name of the project to load the prompt from. Must specify at least one of `projectName` or `projectId`.
 * @param options.projectId The id of the project to load the prompt from. This takes precedence over `projectName` if specified.
 * @param options.slug The slug of the prompt to load.
 * @param options.version An optional version of the prompt (to read). If not specified, the latest version will be used.
 * @param options.environment Fetch the version of the prompt assigned to the specified environment (e.g. "production", "staging"). Cannot be specified at the same time as `version`.
 * @param options.id The id of a specific prompt to load. If specified, this takes precedence over all other parameters (project and slug).
 * @param options.defaults (Optional) A dictionary of default values to use when rendering the prompt. Prompt values will override these defaults.
 * @param options.noTrace If true, do not include logging metadata for this prompt when build() is called.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. If no API
 * key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @returns The prompt object.
 * @throws If the prompt is not found.
 * @throws If multiple prompts are found with the same slug in the same project (this should never happen).
 *
 * @example
 * ```javascript
 * const prompt = await loadPrompt({
 *  projectName: "My Project",
 *  slug: "my-prompt",
 * });
 * ```
 */
export async function loadPrompt({
  projectName,
  projectId,
  slug,
  version,
  environment,
  id,
  defaults,
  noTrace = false,
  appUrl,
  apiKey,
  orgName,
  fetch,
  forceLogin,
  state: stateArg,
}: LoadPromptOptions) {
  if (version && environment) {
    throw new Error(
      "Cannot specify both 'version' and 'environment' parameters. Please use only one (remove the other).",
    );
  }
  if (id) {
    // When loading by ID, we don't need project or slug
  } else if (isEmpty(projectName) && isEmpty(projectId)) {
    throw new Error("Must specify either projectName or projectId");
  } else if (isEmpty(slug)) {
    throw new Error("Must specify slug");
  }

  const state = stateArg ?? _globalState;
  let response;
  try {
    await state.login({
      orgName,
      apiKey,
      appUrl,
      fetch,
      forceLogin,
    });
    if (id) {
      // Load prompt by ID using the /v1/prompt/{id} endpoint
      response = await state.apiConn().get_json(`v1/prompt/${id}`, {
        ...(version && { version }),
        ...(environment && { environment }),
      });
      // Wrap single prompt response in objects array to match list API format
      if (response) {
        response = { objects: [response] };
      }
    } else {
      response = await state.apiConn().get_json("v1/prompt", {
        project_name: projectName,
        project_id: projectId,
        slug,
        version,
        ...(environment && { environment }),
      });
    }
  } catch (e) {
    // If environment or version was specified, don't fall back to cache
    if (environment || version) {
      throw new Error(`Prompt not found with specified parameters: ${e}`);
    }

    console.warn("Failed to load prompt, attempting to fall back to cache:", e);
    let prompt;
    if (id) {
      prompt = await state.promptCache.get({ id });
      if (!prompt) {
        throw new Error(
          `Prompt with id ${id} not found (not found on server or in local cache): ${e}`,
        );
      }
    } else {
      prompt = await state.promptCache.get({
        slug,
        projectId,
        projectName,
        version: version ?? "latest",
      });
      if (!prompt) {
        throw new Error(
          `Prompt ${slug} (version ${version ?? "latest"}) not found in ${[
            projectName ?? projectId,
          ]} (not found on server or in local cache): ${e}`,
        );
      }
    }
    return prompt;
  }

  if (!("objects" in response) || response.objects.length === 0) {
    if (id) {
      throw new Error(`Prompt with id ${id} not found.`);
    } else {
      throw new Error(
        `Prompt ${slug} not found in ${[projectName ?? projectId]}`,
      );
    }
  } else if (response.objects.length > 1) {
    if (id) {
      throw new Error(
        `Multiple prompts found with id ${id}. This should never happen.`,
      );
    } else {
      throw new Error(
        `Multiple prompts found with slug ${slug} in project ${
          projectName ?? projectId
        }. This should never happen.`,
      );
    }
  }

  const metadata = promptSchema.parse(response["objects"][0]);
  const prompt = new Prompt(metadata, defaults || {}, noTrace);
  try {
    if (id) {
      await state.promptCache.set({ id }, prompt);
    } else if (slug) {
      await state.promptCache.set(
        { slug, projectId, projectName, version: version ?? "latest" },
        prompt,
      );
    }
  } catch (e) {
    console.warn("Failed to set prompt in cache:", e);
  }
  return prompt;
}

/**
 * Load parameters from the specified project.
 *
 * @param options Options for configuring loadParameters().
 * @param options.projectName The name of the project to load the parameters from. Must specify at least one of `projectName` or `projectId`.
 * @param options.projectId The id of the project to load the parameters from. This takes precedence over `projectName` if specified.
 * @param options.slug The slug of the parameters to load.
 * @param options.version An optional version of the parameters (to read). If not specified, the latest version will be used.
 * @param options.environment Fetch the version of the parameters assigned to the specified environment (e.g. "production", "staging"). Cannot be specified at the same time as `version`.
 * @param options.id The id of specific parameters to load. If specified, this takes precedence over all other parameters (project and slug).
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @returns The parameters object.
 * @throws If the parameters are not found.
 * @throws If multiple parameters are found with the same slug in the same project (this should never happen).
 *
 * @example
 * ```typescript
 * const params = await loadParameters({
 *  projectName: "My Project",
 *  slug: "my-parameters",
 * });
 * ```
 */
export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByProjectNameOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;
export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByProjectNameWithEnvOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;
export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByProjectIdOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;
export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByProjectIdWithEnvOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;
export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByIdOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;
export function loadParameters<S extends EvalParameters = EvalParameters>(
  options: LoadParametersByIdWithEnvOptions,
): Promise<RemoteEvalParameters<true, true, InferParameters<S>>>;
export async function loadParameters<
  S extends EvalParameters = EvalParameters,
>({
  projectName,
  projectId,
  slug,
  version,
  environment,
  id,
  appUrl,
  apiKey,
  orgName,
  fetch,
  forceLogin,
  state: stateArg,
}: LoadParametersImplementationOptions): Promise<
  RemoteEvalParameters<true, true, InferParameters<S>>
> {
  if (version && environment) {
    throw new Error(
      "Cannot specify both 'version' and 'environment' parameters. Please use only one (remove the other).",
    );
  }
  if (id) {
    // When loading by ID, we don't need project or slug
  } else if (isEmpty(projectName) && isEmpty(projectId)) {
    throw new Error("Must specify either projectName or projectId");
  } else if (isEmpty(slug)) {
    throw new Error("Must specify slug");
  }

  const state = stateArg ?? _globalState;
  let response;
  try {
    await state.login({
      orgName,
      apiKey,
      appUrl,
      fetch,
      forceLogin,
    });
    if (id) {
      response = await state.apiConn().get_json(`v1/function/${id}`, {
        ...(version && { version }),
        ...(environment && { environment }),
      });
      if (response) {
        response = { objects: [response] };
      }
    } else {
      response = await state.apiConn().get_json("v1/function", {
        project_name: projectName,
        project_id: projectId,
        slug,
        version,
        function_type: "parameters",
        ...(environment && { environment }),
      });
    }
  } catch (e) {
    if (environment || version) {
      throw new Error(`Parameters not found with specified parameters: ${e}`);
    }

    console.warn(
      "Failed to load parameters, attempting to fall back to cache:",
      e,
    );
    let parameters;
    if (id) {
      parameters = await state.parametersCache.get({ id });
      if (!parameters) {
        throw new Error(
          `Parameters with id ${id} not found (not found on server or in local cache): ${e}`,
        );
      }
    } else {
      parameters = await state.parametersCache.get({
        slug,
        projectId,
        projectName,
        version: version ?? "latest",
      });
      if (!parameters) {
        throw new Error(
          `Parameters ${slug} (version ${version ?? "latest"}) not found in ${[
            projectName ?? projectId,
          ]} (not found on server or in local cache): ${e}`,
        );
      }
    }
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return parameters as RemoteEvalParameters<true, true, InferParameters<S>>;
  }

  if (!("objects" in response) || response.objects.length === 0) {
    if (id) {
      throw new Error(`Parameters with id ${id} not found.`);
    } else {
      throw new Error(
        `Parameters ${slug} not found in ${[projectName ?? projectId]}`,
      );
    }
  } else if (response.objects.length > 1) {
    if (id) {
      throw new Error(
        `Multiple parameters found with id ${id}. This should never happen.`,
      );
    } else {
      throw new Error(
        `Multiple parameters found with slug ${slug} in project ${
          projectName ?? projectId
        }. This should never happen.`,
      );
    }
  }

  const metadata = parametersRowSchema.parse(response["objects"][0]);
  const parameters = new RemoteEvalParameters(metadata);
  try {
    if (id) {
      await state.parametersCache.set({ id }, parameters);
    } else if (slug) {
      await state.parametersCache.set(
        { slug, projectId, projectName, version: version ?? "latest" },
        parameters,
      );
    }
  } catch (e) {
    console.warn("Failed to set parameters in cache:", e);
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return parameters as RemoteEvalParameters<true, true, InferParameters<S>>;
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
   * The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable.
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
}

export type FullLoginOptions = LoginOptions & {
  forceLogin?: boolean;
};

/**
 * Set a global masking function that will be applied to all logged data before sending to Braintrust.
 * The masking function will be applied after records are merged but before they are sent to the backend.
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
 * @param options.apiKey The API key to use. If the parameter is not specified, will try to use the `BRAINTRUST_API_KEY` environment variable. If no API
 * key is specified, will prompt the user to login.
 * @param options.orgName (Optional) The name of a specific organization to connect to. This is useful if you belong to multiple.
 * @param options.forceLogin Login again, even if you have already logged in (by default, this function will exit quickly if you have already logged in)
 */
export async function login(
  options: LoginOptions & { forceLogin?: boolean } = {},
): Promise<BraintrustState> {
  const { forceLogin = false } = options || {};

  const state = _internalGetGlobalState();
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

  if (!state) {
    _internalSetInitialState();
  }

  await state.login(options);
  return state;
}

export async function loginToState(options: LoginOptions = {}) {
  const {
    appUrl = iso.getEnv("BRAINTRUST_APP_URL") || "https://www.braintrust.dev",
    apiKey = iso.getEnv("BRAINTRUST_API_KEY"),
    orgName = iso.getEnv("BRAINTRUST_ORG_NAME"),
    fetch = globalThis.fetch,
  } = options || {};

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
    const resp = await checkResponse(
      await fetch(_urljoin(state.appUrl, `/api/apikey/login`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }),
    );
    const info = await resp.json();

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
  console.warn(
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
  console.warn(
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
  const state = options?.state ?? _globalState;
  return state.currentExperiment;
}

/**
 * Returns the currently-active logger (set by {@link initLogger}). Returns undefined if no current logger has been set.
 */
export function currentLogger<IsAsyncFlush extends boolean>(
  options?: AsyncFlushArg<IsAsyncFlush> & OptionalStateArg,
): Logger<IsAsyncFlush> | undefined {
  const state = options?.state ?? _globalState;
  return castLogger(state.currentLogger, options?.asyncFlush);
}

/**
 * Return the currently-active span for logging (set by one of the `traced` methods). If there is no active span, returns a no-op span object, which supports the same interface as spans but does no logging.
 *
 * See {@link Span} for full details.
 */
export function currentSpan(options?: OptionalStateArg): Span {
  const state = options?.state ?? _globalState;
  return state.contextManager.getCurrentSpan() ?? NOOP_SPAN;
}

/**
 * Mainly for internal use. Return the parent object for starting a span in a global context.
 * Applies precedence: current span > propagated parent string > experiment > logger.
 */
export function getSpanParentObject<IsAsyncFlush extends boolean>(
  options?: AsyncFlushArg<IsAsyncFlush> &
    OptionalStateArg & { parent?: string },
):
  | SpanComponentsV3
  | SpanComponentsV4
  | Span
  | Experiment
  | Logger<IsAsyncFlush> {
  const state = options?.state ?? _globalState;

  const parentSpan = currentSpan({ state });
  if (!Object.is(parentSpan, NOOP_SPAN)) {
    return parentSpan;
  }

  const parentStr = options?.parent ?? state.currentParent.getStore();
  if (parentStr) return getSpanComponentsClass().fromStr(parentStr);

  const experiment = currentExperiment();
  if (experiment) {
    return experiment;
  }
  const logger = currentLogger<IsAsyncFlush>(options);
  if (logger) {
    return logger;
  }
  return NOOP_SPAN;
}

export function logError(span: Span, error: unknown) {
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
export function traced<IsAsyncFlush extends boolean = true, R = void>(
  callback: (span: Span) => R,
  args?: StartSpanArgs &
    SetCurrentArg &
    AsyncFlushArg<IsAsyncFlush> &
    OptionalStateArg,
): PromiseUnless<IsAsyncFlush, R> {
  const { span, isSyncFlushLogger } = startSpanAndIsLogger(args);

  const ret = runCatchFinally(
    () => {
      if (args?.setCurrent ?? true) {
        return withCurrent(span, callback);
      } else {
        return callback(span);
      }
    },
    (e) => {
      logError(span, e);
      throw e;
    },
    () => span.end(),
  );

  type Ret = PromiseUnless<IsAsyncFlush, R>;

  if (args?.asyncFlush === undefined || args?.asyncFlush) {
    return ret as Ret;
  } else {
    return (async () => {
      const awaitedRet = await ret;
      if (isSyncFlushLogger) {
        await span.flush();
      }
      return awaitedRet;
    })() as Ret;
  }
}

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
function isGeneratorFunction(fn: any): boolean {
  return Object.prototype.toString.call(fn) === "[object GeneratorFunction]";
}

/**
 * Check if a function is an async generator function.
 *
 * Note: see isGeneratorFunction disclaimer
 * @param fn The function to check.
 * @returns True if the function is an async generator function.
 */
function isAsyncGeneratorFunction(fn: any): boolean {
  return (
    Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]"
  );
}

/**
 * Wrap a sync generator function with tracing.
 */
function wrapTracedSyncGenerator<F extends (...args: any[]) => any>(
  fn: F,
  spanArgs: any,
  noTraceIO: boolean,
): F {
  const wrapper = function* (this: any, ...fnArgs: Parameters<F>) {
    const span = startSpan(spanArgs);
    try {
      if (!noTraceIO) {
        span.log({ input: fnArgs });
      }

      const envValue = iso.getEnv("BRAINTRUST_MAX_GENERATOR_ITEMS");
      const maxItems = envValue !== undefined ? Number(envValue) : 1000;

      if (!noTraceIO && maxItems !== 0) {
        let collected: any[] = [];
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
              console.warn(
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
  spanArgs: any,
  noTraceIO: boolean,
): F {
  const wrapper = async function* (this: any, ...fnArgs: Parameters<F>) {
    const span = startSpan(spanArgs);
    try {
      if (!noTraceIO) {
        span.log({ input: fnArgs });
      }

      const envValue = iso.getEnv("BRAINTRUST_MAX_GENERATOR_ITEMS");
      const maxItems = envValue !== undefined ? Number(envValue) : 1000;

      if (!noTraceIO && maxItems !== 0) {
        let collected: any[] = [];
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
              console.warn(
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

type WrapTracedArgs = {
  noTraceIO?: boolean;
};

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
export function wrapTraced<
  F extends (...args: any[]) => any,
  IsAsyncFlush extends boolean = true,
>(
  fn: F,
  args?: StartSpanArgs &
    SetCurrentArg &
    AsyncFlushArg<IsAsyncFlush> &
    WrapTracedArgs,
): IsAsyncFlush extends false
  ? (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>
  : F {
  const spanArgs: typeof args = {
    name: fn.name,
    type: "function",
    ...args,
  };
  const hasExplicitInput =
    args &&
    args.event &&
    "input" in args.event &&
    args.event.input !== undefined;
  const hasExplicitOutput =
    args && args.event && args.event.output !== undefined;

  const noTraceIO = args?.noTraceIO || hasExplicitInput || hasExplicitOutput;
  // Check if the function is a generator
  if (isGeneratorFunction(fn)) {
    return wrapTracedSyncGenerator(fn, spanArgs, !!noTraceIO);
  }

  if (isAsyncGeneratorFunction(fn)) {
    return wrapTracedAsyncGenerator(fn, spanArgs, !!noTraceIO);
  }

  if (args?.asyncFlush) {
    return ((...fnArgs: Parameters<F>) =>
      traced((span) => {
        if (!hasExplicitInput) {
          span.log({ input: fnArgs });
        }

        const output = fn(...fnArgs);

        if (!hasExplicitOutput) {
          if (output instanceof Promise) {
            return (async () => {
              const result = await output;
              span.log({ output: result });
              return result;
            })();
          } else {
            span.log({ output: output });
          }
        }

        return output;
      }, spanArgs)) as IsAsyncFlush extends false ? never : F;
  } else {
    return ((...fnArgs: Parameters<F>) =>
      traced(async (span) => {
        if (!hasExplicitInput) {
          span.log({ input: fnArgs });
        }

        const outputResult = fn(...fnArgs);

        const output = await outputResult;

        if (!hasExplicitOutput) {
          span.log({ output });
        }

        return output;
      }, spanArgs)) as IsAsyncFlush extends false
      ? (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>>
      : never;
  }
}

/**
 * A synonym for `wrapTraced`. If you're porting from systems that use `traceable`, you can use this to
 * make your codebase more consistent.
 */
export const traceable = wrapTraced;

/**
 * Lower-level alternative to `traced`. This allows you to start a span yourself, and can be useful in situations
 * where you cannot use callbacks. However, spans started with `startSpan` will not be marked as the "current span",
 * so `currentSpan()` and `traced()` will be no-ops. If you want to mark a span as current, use `traced` instead.
 *
 * See {@link traced} for full details.
 */
export function startSpan<IsAsyncFlush extends boolean = true>(
  args?: StartSpanArgs & AsyncFlushArg<IsAsyncFlush> & OptionalStateArg,
): Span {
  return startSpanAndIsLogger(args).span;
}

/**
 * Flush any pending rows to the server.
 */
export async function flush(options?: OptionalStateArg): Promise<void> {
  const state = options?.state ?? _globalState;
  return await state.bgLogger().flush();
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

function startSpanAndIsLogger<IsAsyncFlush extends boolean = true>(
  args?: StartSpanArgs & AsyncFlushArg<IsAsyncFlush> & OptionalStateArg,
): { span: Span; isSyncFlushLogger: boolean } {
  const state = args?.state ?? _globalState;

  const parentObject = getSpanParentObject<IsAsyncFlush>({
    asyncFlush: args?.asyncFlush,
    parent: args?.parent,
    state,
  });

  if (
    parentObject instanceof SpanComponentsV3 ||
    parentObject instanceof SpanComponentsV4
  ) {
    const parentSpanIds: ParentSpanIds | undefined = parentObject.data.row_id
      ? {
          spanId: parentObject.data.span_id,
          rootSpanId: parentObject.data.root_span_id,
        }
      : undefined;
    const span = new SpanImpl({
      state,
      ...args,
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
    });
    return {
      span,
      isSyncFlushLogger:
        parentObject.data.object_type === SpanObjectTypeV3.PROJECT_LOGS &&
        // Since there's no parent logger here, we're free to choose the async flush
        // behavior, and therefore propagate along whatever we get from the arguments
        args?.asyncFlush === false,
    };
  } else {
    const span = parentObject.startSpan(args);
    return {
      span,
      isSyncFlushLogger:
        parentObject.kind === "logger" && parentObject.asyncFlush === false,
    };
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
  const currentState = state ?? _globalState;
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
  parent: string,
  callback: () => R,
  state: BraintrustState | undefined = undefined,
): R {
  return (state ?? _globalState).currentParent.run(parent, () => callback());
}

function _saveOrgInfo(
  state: BraintrustState,
  org_info: any,
  org_name: string | undefined,
) {
  if (org_info.length === 0) {
    throw new LoginInvalidOrgError(
      "This user is not part of any organizations.",
    );
  }

  for (const org of org_info) {
    if (org_name === undefined || org.name === org_name) {
      state.orgId = org.id;
      state.orgName = org.name;
      state.apiUrl = iso.getEnv("BRAINTRUST_API_URL") ?? org.api_url;
      state.proxyUrl = iso.getEnv("BRAINTRUST_PROXY_URL") ?? org.proxy_url;
      state.gitMetadataSettings = org.git_metadata || undefined;
      break;
    }
  }

  if (state.orgId === undefined) {
    throw new LoginInvalidOrgError(
      `Organization ${org_name} not found. Must be one of ${org_info
        .map((x: any) => x.name)
        .join(", ")}`,
    );
  }
}

function validateTags(tags: readonly string[]) {
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

  if ("input" in event && event.input && "inputs" in event && event.inputs) {
    throw new Error(
      "Only one of input or inputs (deprecated) can be specified. Prefer input.",
    );
  }

  if ("tags" in event && event.tags) {
    validateTags(event.tags);
  }

  if ("inputs" in event) {
    const { inputs, ...rest } = event;
    return { input: inputs, ...rest };
  } else {
    return { ...event };
  }
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
  const IDENTIFIER = "_bt_internal_saved_attachment";
  const savedAttachmentSchema = z.strictObject({ [IDENTIFIER]: z.number() });

  // We both check for serializability and round-trip `event` through JSON in
  // order to create a "deep copy". This has the benefit of cutting out any
  // reference to user objects when the object is logged asynchronously, so that
  // in case the objects are modified, the logging is unaffected. In the future,
  // this could be changed to a "real" deep copy so that immutable types (long
  // strings) do not have to be copied.
  const serialized = JSON.stringify(event, (_k, v) => {
    if (v instanceof SpanImpl || v instanceof NoopSpan) {
      return `<span>`;
    } else if (v instanceof Experiment) {
      return `<experiment>`;
    } else if (v instanceof Dataset) {
      return `<dataset>`;
    } else if (v instanceof Logger) {
      return `<logger>`;
    } else if (v instanceof BaseAttachment) {
      const idx = attachments.push(v);
      return { [IDENTIFIER]: idx - 1 };
    } else if (v instanceof ReadonlyAttachment) {
      return v.reference;
    }
    return v;
  });
  const x = JSON.parse(serialized, (_k, v) => {
    const parsedAttachment = savedAttachmentSchema.safeParse(v);
    if (parsedAttachment.success) {
      return attachments[parsedAttachment.data[IDENTIFIER]];
    }
    return v;
  });
  return x;
}

/**
 * Helper function for uploading attachments. Recursively extracts `Attachment`
 * and `ExternalAttachment` objects and replaces them with their associated
 * `AttachmentReference` objects.
 *
 * @param event The event to filter. Will be modified in-place.
 * @param attachments Flat array of extracted attachments (output parameter).
 */
function extractAttachments(
  event: Record<string, any>,
  attachments: BaseAttachment[],
): void {
  for (const [key, value] of Object.entries(event)) {
    if (!value) {
      continue;
    }

    // Base case: Attachment or ExternalAttachment.
    if (value instanceof BaseAttachment) {
      attachments.push(value);
      event[key] = value.reference;
      continue; // Attachment cannot be nested.
    }

    // Skip if this is already just a reference (no uploader field)
    if (value?.type === BRAINTRUST_ATTACHMENT && value.key && !value.uploader) {
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
      attachments.push(attachment);
      event[key] = attachment.reference;
      continue;
    }

    // Base case: non-object.
    if (!(value instanceof Object)) {
      continue; // Nothing to explore recursively.
    }

    // Recursive case: object or array.
    extractAttachments(value, attachments);
  }
}

/**
 * Recursively hydrates any `AttachmentReference` into `Attachment` by modifying
 * the input in-place.
 *
 * @returns The same event instance as the input.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enrichAttachments<T extends Record<string, any>>(
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
async function resolveAttachmentsToBase64<T extends Record<string, any>>(
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
function validateAndSanitizeExperimentLogFullArgs(
  event: ExperimentLogFullArgs,
  hasDataset: boolean,
): ExperimentLogFullArgs {
  if (
    ("input" in event &&
      !isEmpty(event.input) &&
      "inputs" in event &&
      !isEmpty(event.inputs)) ||
    (!("input" in event) && !("inputs" in event))
  ) {
    throw new Error(
      "Exactly one of input or inputs (deprecated) must be specified. Prefer input.",
    );
  }

  if (isEmpty(event.output)) {
    throw new Error("output must be specified");
  }
  if (isEmpty(event.scores)) {
    throw new Error("scores must be specified");
  }

  if (hasDataset && event.datasetRecordId === undefined) {
    throw new Error("datasetRecordId must be specified when using a dataset");
  } else if (!hasDataset && event.datasetRecordId !== undefined) {
    throw new Error(
      "datasetRecordId cannot be specified when not using a dataset",
    );
  }

  return event;
}

export type WithTransactionId<R> = R & {
  [TRANSACTION_ID_FIELD]: TransactionId;
};

export const DEFAULT_FETCH_BATCH_SIZE = 1000;
export const MAX_BTQL_ITERATIONS = 10000;

export class ObjectFetcher<RecordType> implements AsyncIterable<
  WithTransactionId<RecordType>
> {
  private _fetchedData: WithTransactionId<RecordType>[] | undefined = undefined;

  constructor(
    private objectType:
      | "dataset"
      | "experiment"
      | "project_logs"
      | "playground_logs",
    private pinnedVersion: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mutateRecord?: (r: any) => WithTransactionId<RecordType>,
    private _internal_btql?: Record<string, unknown>,
  ) {}

  public get id(): Promise<string> {
    throw new Error("ObjectFetcher subclasses must have an 'id' attribute");
  }

  protected async getState(): Promise<BraintrustState> {
    throw new Error("ObjectFetcher subclasses must have a 'getState' method");
  }

  private async *fetchRecordsFromApi(
    batchSize: number | undefined,
  ): AsyncGenerator<WithTransactionId<RecordType>> {
    const state = await this.getState();
    const objectId = await this.id;
    const limit = batchSize ?? DEFAULT_FETCH_BATCH_SIZE;
    let cursor = undefined;
    let iterations = 0;
    while (true) {
      const resp = await state.apiConn().post(
        `btql`,
        {
          query: {
            ...this._internal_btql,
            select: [
              {
                op: "star",
              },
            ],
            from: {
              op: "function",
              name: {
                op: "ident",
                name: [this.objectType],
              },
              args: [
                {
                  op: "literal",
                  value: objectId,
                },
              ],
            },
            cursor,
            limit,
          },
          use_columnstore: false,
          brainstore_realtime: true,
          query_source: `js_sdk_object_fetcher_${this.objectType}`,
          ...(this.pinnedVersion !== undefined
            ? {
                version: this.pinnedVersion,
              }
            : {}),
        },
        { headers: { "Accept-Encoding": "gzip" } },
      );
      const respJson = await resp.json();
      const mutate = this.mutateRecord;
      for (const record of respJson.data ?? []) {
        yield mutate
          ? mutate(record)
          : (record as WithTransactionId<RecordType>);
      }
      if (!respJson.cursor) {
        break;
      }
      cursor = respJson.cursor;
      iterations++;
      if (iterations > MAX_BTQL_ITERATIONS) {
        throw new Error("Too many BTQL iterations");
      }
    }
  }

  /**
   * Fetch all records from the object.
   *
   * @param options Optional parameters for fetching.
   * @param options.batchSize The number of records to fetch per request. Defaults to 1000.
   * @returns An async generator of records.
   */
  async *fetch(options?: {
    batchSize?: number;
  }): AsyncGenerator<WithTransactionId<RecordType>> {
    if (this._fetchedData !== undefined) {
      for (const record of this._fetchedData) {
        yield record;
      }
      return;
    }

    for await (const record of this.fetchRecordsFromApi(options?.batchSize)) {
      yield record;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<WithTransactionId<RecordType>> {
    return this.fetch();
  }

  async fetchedData(options?: { batchSize?: number }) {
    if (this._fetchedData === undefined) {
      const data: WithTransactionId<RecordType>[] = [];
      for await (const record of this.fetchRecordsFromApi(options?.batchSize)) {
        data.push(record);
      }
      this._fetchedData = data;
    }
    return this._fetchedData || [];
  }

  clearCache() {
    this._fetchedData = undefined;
  }

  public async version(options?: { batchSize?: number }) {
    if (this.pinnedVersion !== undefined) {
      return this.pinnedVersion;
    } else {
      let maxVersion: string | undefined = undefined;
      for await (const record of this.fetch(options)) {
        const xactId = String(record[TRANSACTION_ID_FIELD] ?? "0");
        if (maxVersion === undefined || xactId > maxVersion) {
          maxVersion = xactId;
        }
      }
      return maxVersion;
    }
  }
}

export type BaseMetadata = Record<string, unknown> | void;
export type DefaultMetadataType = void;
export type EvalCase<Input, Expected, Metadata> = {
  input: Input;
  tags?: string[];
  // These fields are only set if the EvalCase is part of a Dataset.
  id?: string;
  _xact_id?: TransactionId;
  created?: string | null;
  // This field is used to help re-run a particular experiment row.
  upsert_id?: string;
} & (Expected extends void ? object : { expected: Expected }) &
  (Metadata extends void ? object : { metadata: Metadata });

/**
 * An experiment is a collection of logged events, such as model inputs and outputs, which represent
 * a snapshot of your application at a particular point in time. An experiment is meant to capture more
 * than just the model you use, and includes the data you use to test, pre- and post- processing code,
 * comparison metrics (scores), and any other metadata you want to include.
 *
 * Experiments are associated with a project, and two experiments are meant to be easily comparable via
 * their `inputs`. You can change the attributes of the experiments in a project (e.g. scoring functions)
 * over time, simply by changing what you log.
 *
 * You should not create `Experiment` objects directly. Instead, use the `braintrust.init()` method.
 */
export class Experiment
  extends ObjectFetcher<ExperimentEvent>
  implements Exportable
{
  private readonly lazyMetadata: LazyValue<ProjectExperimentMetadata>;
  public readonly dataset?: AnyDataset;
  private lastStartTime: number;
  private lazyId: LazyValue<string>;
  private calledStartSpan: boolean;
  private state: BraintrustState;

  // For type identification.
  public kind = "experiment" as const;

  constructor(
    state: BraintrustState,
    lazyMetadata: LazyValue<ProjectExperimentMetadata>,
    dataset?: AnyDataset,
  ) {
    super("experiment", undefined, (r) => enrichAttachments(r, state));
    this.lazyMetadata = lazyMetadata;
    this.dataset = dataset;
    this.lastStartTime = getCurrentUnixTimestamp();
    this.lazyId = new LazyValue(async () => await this.id);
    this.calledStartSpan = false;
    this.state = state;
  }

  public get id(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).experiment.id;
    })();
  }

  public get loggingState(): BraintrustState {
    return this.state;
  }

  /**
   * Wait for the experiment ID to be resolved. This is useful for ensuring the ID
   * is available synchronously in child spans (for OTEL parent attributes).
   * @internal
   */
  public async _waitForId(): Promise<void> {
    await this.lazyId.get().catch(() => {
      // Ignore errors
    });
  }

  public get name(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).experiment.name;
    })();
  }

  public get project(): Promise<ObjectMetadata> {
    return (async () => {
      return (await this.lazyMetadata.get()).project;
    })();
  }

  private parentObjectType() {
    return SpanObjectTypeV3.EXPERIMENT;
  }

  protected async getState(): Promise<BraintrustState> {
    // Ensure the login state is populated by awaiting lazyMetadata.
    await this.lazyMetadata.get();
    return this.state;
  }

  /**
   * Log a single event to the experiment. The event will be batched and uploaded behind the scenes.
   *
   * @param event The event to log.
   * @param event.input: The arguments that uniquely define a test case (an arbitrary, JSON serializable object). Later on, Braintrust will use the `input` to know whether two test cases are the same between experiments, so they should not contain experiment-specific state. A simple rule of thumb is that if you run the same experiment twice, the `input` should be identical.
   * @param event.output: The output of your application, including post-processing (an arbitrary, JSON serializable object), that allows you to determine whether the result is correct or not. For example, in an app that generates SQL queries, the `output` should be the _result_ of the SQL query generated by the model, not the query itself, because there may be multiple valid queries that answer a single question.
   * @param event.expected: (Optional) The ground truth value (an arbitrary, JSON serializable object) that you'd compare to `output` to determine if your `output` value is correct or not. Braintrust currently does not compare `output` to `expected` for you, since there are so many different ways to do that correctly. Instead, these values are just used to help you navigate your experiments while digging into analyses. However, we may later use these values to re-score outputs or fine-tune your models.
   * @param event.error: (Optional) The error that occurred, if any. If you use tracing to run an experiment, errors are automatically logged when your code throws an exception.
   * @param event.scores: A dictionary of numeric values (between 0 and 1) to log. The scores should give you a variety of signals that help you determine how accurate the outputs are compared to what you expect and diagnose failures. For example, a summarization app might have one score that tells you how accurate the summary is, and another that measures the word similarity between the generated and grouth truth summary. The word similarity score could help you determine whether the summarization was covering similar concepts or not. You can use these scores to help you sort, filter, and compare experiments.
   * @param event.metadata: (Optional) a dictionary with additional data about the test example, model outputs, or just about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any JSON-serializable type, but its keys must be strings.
   * @param event.metrics: (Optional) a dictionary of metrics to log. The following keys are populated automatically: "start", "end".
   * @param event.id: (Optional) a unique identifier for the event. If you don't provide one, BrainTrust will generate one for you.
   * @param event.dataset_record_id: (Optional) the id of the dataset record that this event is associated with. This field is required if and only if the experiment is associated with a dataset. This field is unused and will be removed in a future version.
   * @param options Additional logging options
   * @param options.allowConcurrentWithSpans in rare cases where you need to log at the top level separately from spans on the experiment elsewhere, set this to true.
   * @returns The `id` of the logged event.
   */
  public log(
    event: Readonly<ExperimentLogFullArgs>,
    options?: { allowConcurrentWithSpans?: boolean },
  ): string {
    if (this.calledStartSpan && !options?.allowConcurrentWithSpans) {
      throw new Error(
        "Cannot run toplevel `log` method while using spans. To log to the span, call `experiment.traced` and then log with `span.log`",
      );
    }

    event = validateAndSanitizeExperimentLogFullArgs(event, !!this.dataset);
    const span = this.startSpanImpl({ startTime: this.lastStartTime, event });
    this.lastStartTime = span.end();
    return span.id;
  }

  /**
   * Create a new toplevel span underneath the experiment. The name defaults to "root".
   *
   * See {@link Span.traced} for full details.
   */
  public traced<R>(
    callback: (span: Span) => R,
    args?: StartSpanArgs & SetCurrentArg,
  ): R {
    const { setCurrent, ...argsRest } = args ?? {};
    const span = this.startSpan(argsRest);

    const ret = runCatchFinally(
      () => {
        if (setCurrent ?? true) {
          return withCurrent(span, callback);
        } else {
          return callback(span);
        }
      },
      (e) => {
        logError(span, e);
        throw e;
      },
      () => span.end(),
    );

    return ret as R;
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
      ...args,
      // Sometimes `args` gets passed directly into this function, and it contains an undefined value for `state`.
      // To ensure that we always use this experiment's state, we override the `state` argument no matter what.
      state: this.state,
      ...startSpanParentArgs({
        state: this.state,
        parent: args?.parent,
        parentObjectType: this.parentObjectType(),
        parentObjectId: this.lazyId,
        parentComputeObjectMetadataArgs: undefined,
        parentSpanIds: undefined,
        propagatedEvent: args?.propagatedEvent,
      }),
      defaultRootType: SpanTypeAttribute.EVAL,
    });
  }

  public async fetchBaseExperiment() {
    const state = await this.getState();
    const conn = state.appConn();

    try {
      const resp = await conn.post("/api/base_experiment/get_id", {
        id: await this.id,
      });

      const base = await resp.json();
      return {
        id: base["base_exp_id"],
        name: base["base_exp_name"],
      };
    } catch (e) {
      if (e instanceof FailedHTTPResponse && e.status === 400) {
        // No base experiment
        return null;
      } else {
        throw e;
      }
    }
  }

  /**
   * Summarize the experiment, including the scores (compared to the closest reference experiment) and metadata.
   *
   * @param options Options for summarizing the experiment.
   * @param options.summarizeScores Whether to summarize the scores. If False, only the metadata will be returned.
   * @param options.comparisonExperimentId The experiment to compare against. If None, the most recent experiment on the origin's main branch will be used.
   * @returns A summary of the experiment, including the scores (compared to the closest reference experiment) and metadata.
   */
  public async summarize(
    options: {
      readonly summarizeScores?: boolean;
      readonly comparisonExperimentId?: string;
    } = {},
  ): Promise<ExperimentSummary> {
    const {
      summarizeScores = true,
      comparisonExperimentId: comparisonExperimentIdOpt,
    } = options || {};
    let comparisonExperimentId = comparisonExperimentIdOpt;

    const state = await this.getState();
    const projectUrl = `${state.appPublicUrl}/app/${encodeURIComponent(
      state.orgName!,
    )}/p/${encodeURIComponent((await this.project).name)}`;
    const experimentUrl = `${projectUrl}/experiments/${encodeURIComponent(
      await this.name,
    )}`;

    let scores: Record<string, ScoreSummary> | undefined = undefined;
    let metrics: Record<string, MetricSummary> | undefined = undefined;
    let comparisonExperimentName = undefined;
    if (summarizeScores) {
      await this.flush();
      if (comparisonExperimentId === undefined) {
        const baseExperiment = await this.fetchBaseExperiment();
        if (baseExperiment !== null) {
          comparisonExperimentId = baseExperiment.id;
          comparisonExperimentName = baseExperiment.name;
        }
      }

      try {
        const results = await state.apiConn().get_json(
          "/experiment-comparison2",
          {
            experiment_id: await this.id,
            base_experiment_id: comparisonExperimentId,
          },
          3,
        );

        scores = results["scores"];
        metrics = results["metrics"];
      } catch (e) {
        console.warn(
          `Failed to fetch experiment scores and metrics: ${e}\n\nView complete results in Braintrust or run experiment.summarize() again.`,
        );
        scores = {};
        metrics = {};
      }
    }

    return {
      projectName: (await this.project).name,
      experimentName: await this.name,
      projectId: (await this.project).id,
      experimentId: await this.id,
      projectUrl: projectUrl,
      experimentUrl: experimentUrl,
      comparisonExperimentName: comparisonExperimentName,
      scores: scores ?? {},
      metrics: metrics ?? {},
    };
  }

  /**
   * Log feedback to an event in the experiment. Feedback is used to save feedback scores, set an expected value, or add a comment.
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
   * Return a serialized representation of the experiment that can be used to start subspans in other places.
   *
   * See {@link Span.startSpan} for more details.
   */
  public async export(): Promise<string> {
    return new (getSpanComponentsClass())({
      object_type: this.parentObjectType(),
      object_id: await this.id,
    }).toStr();
  }

  /**
   * Flush any pending rows to the server.
   */
  async flush(): Promise<void> {
    return await this.state.bgLogger().flush();
  }

  /**
   * @deprecated This function is deprecated. You can simply remove it from your code.
   */
  public async close(): Promise<string> {
    console.warn(
      "close is deprecated and will be removed in a future version of braintrust. It is now a no-op and can be removed",
    );
    return this.id;
  }
}

/**
 * A read-only view of an experiment, initialized by passing `open: true` to `init()`.
 */
export class ReadonlyExperiment extends ObjectFetcher<ExperimentEvent> {
  constructor(
    private state: BraintrustState,
    private readonly lazyMetadata: LazyValue<ProjectExperimentMetadata>,
  ) {
    super("experiment", undefined, (r) => enrichAttachments(r, state));
  }

  public get id(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).experiment.id;
    })();
  }

  public get name(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).experiment.name;
    })();
  }

  public get loggingState(): BraintrustState {
    return this.state;
  }

  protected async getState(): Promise<BraintrustState> {
    // Ensure the login state is populated by awaiting lazyMetadata.
    await this.lazyMetadata.get();
    return this.state;
  }

  public async *asDataset<
    Input,
    Expected,
    Metadata = DefaultMetadataType,
  >(options?: {
    batchSize?: number;
  }): AsyncGenerator<EvalCase<Input, Expected, Metadata>> {
    const records = this.fetch(options);

    for await (const record of records) {
      if (record.root_span_id !== record.span_id) {
        continue;
      }

      const { output, expected: expectedRecord, metadata } = record;
      const expected = (expectedRecord ?? output) as Expected;

      // Note: We always include expected and metadata fields to maintain type signature alignment.
      // This ensures that when the type signature includes `| null | undefined`, the fields
      // are still present in the runtime object. While this may incorrectly include fields
      // when Metadata/Expected = void, it's preferable to incorrectly excluding them when
      // the type signature expects them to be present.
      yield {
        input: record.input as Input,
        tags: record.tags,
        expected: expected as Expected,
        metadata: metadata as Metadata,
      } as unknown as EvalCase<Input, Expected, Metadata>;
    }
  }
}

let executionCounter = 0;

export function newId() {
  return uuidv4();
}

interface ResolvedSpanIds {
  spanId: string;
  rootSpanId: string;
  spanParents: string[] | undefined;
}

/**
 * Resolve all span IDs (span_id, root_span_id, span_parents) from explicit values, parent info, or context.
 * Matches the Python implementation in logger.py::_resolve_span_ids.
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
    } & Omit<StartSpanArgs, "parent">,
  ) {
    this._state = args.state;

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
      context: { ...callerLocation },
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

    // The first log is a replacement, but subsequent logs to the same span
    // object will be merges.
    this.isMerge = false;
    this.logInternal({ event, internalData });
    this.isMerge = true;
  }

  public getParentInfo() {
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
        metadata: partialRecord.metadata,
        span_id: this._spanId,
        span_parents: this._spanParents,
        span_attributes: partialRecord.span_attributes,
      };
      this._state.spanCache.queueWrite(
        this._rootSpanId,
        this._spanId,
        cachedSpan,
      );
    }

    const computeRecord = async () => ({
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
    });
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
      (e) => {
        logError(span, e);
        throw e;
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
      ...args,
      ...startSpanParentArgs({
        state: this._state,
        parent: args?.parent,
        parentObjectType: this.parentObjectType,
        parentObjectId: this.parentObjectId,
        parentComputeObjectMetadataArgs: this.parentComputeObjectMetadataArgs,
        parentSpanIds,
        propagatedEvent: args?.propagatedEvent ?? this.propagatedEvent,
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
      ...args,
      ...startSpanParentArgs({
        state: this._state,
        parent: args?.parent,
        parentObjectType: this.parentObjectType,
        parentObjectId: this.parentObjectId,
        parentComputeObjectMetadataArgs: this.parentComputeObjectMetadataArgs,
        parentSpanIds,
        propagatedEvent: args?.propagatedEvent ?? this.propagatedEvent,
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

  public close(args?: EndSpanArgs): number {
    return this.end(args);
  }

  public state(): BraintrustState {
    return this._state;
  }

  // Custom inspect for Node.js console.log
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SpanImpl {
  kind: '${this.kind}',
  id: '${this.id}',
  spanId: '${this.spanId}',
  rootSpanId: '${this.rootSpanId}',
  spanParents: ${JSON.stringify(this.spanParents)}
}`;
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

/**
 * A dataset is a collection of records, such as model inputs and expected outputs, which represent
 * data you can use to evaluate and fine-tune models. You can log production data to datasets,
 * curate them with interesting examples, edit/delete records, and run evaluations against them.
 *
 * You should not create `Dataset` objects directly. Instead, use the `braintrust.initDataset()` method.
 */
export class Dataset<
  IsLegacyDataset extends boolean = typeof DEFAULT_IS_LEGACY_DATASET,
> extends ObjectFetcher<DatasetRecord<IsLegacyDataset>> {
  private readonly lazyMetadata: LazyValue<ProjectDatasetMetadata>;
  private readonly __braintrust_dataset_marker = true;
  private newRecords = 0;

  constructor(
    private state: BraintrustState,
    lazyMetadata: LazyValue<ProjectDatasetMetadata>,
    pinnedVersion?: string,
    legacy?: IsLegacyDataset,
    _internal_btql?: Record<string, unknown>,
  ) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const isLegacyDataset = (legacy ??
      DEFAULT_IS_LEGACY_DATASET) as IsLegacyDataset;
    if (isLegacyDataset) {
      console.warn(
        `Records will be fetched from this dataset in the legacy format, with the "expected" field renamed to "output". Please update your code to use "expected", and use \`braintrust.initDataset()\` with \`{ useOutput: false }\`, which will become the default in a future version of Braintrust.`,
      );
    }
    super(
      "dataset",
      pinnedVersion,
      (r: AnyDatasetRecord) =>
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        ensureDatasetRecord(
          enrichAttachments(r, this.state),
          isLegacyDataset,
        ) as WithTransactionId<DatasetRecord<IsLegacyDataset>>,
      _internal_btql,
    );
    this.lazyMetadata = lazyMetadata;
  }

  public get id(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).dataset.id;
    })();
  }

  public get name(): Promise<string> {
    return (async () => {
      return (await this.lazyMetadata.get()).dataset.name;
    })();
  }

  public get project(): Promise<ObjectMetadata> {
    return (async () => {
      return (await this.lazyMetadata.get()).project;
    })();
  }

  public get loggingState(): BraintrustState {
    return this.state;
  }

  protected async getState(): Promise<BraintrustState> {
    // Ensure the login state is populated by awaiting lazyMetadata.
    await this.lazyMetadata.get();
    return this.state;
  }

  private validateEvent({
    metadata,
    expected,
    output,
    tags,
  }: {
    metadata?: Record<string, unknown>;
    expected?: unknown;
    output?: unknown;
    tags?: string[];
  }) {
    if (metadata !== undefined) {
      for (const key of Object.keys(metadata)) {
        if (typeof key !== "string") {
          throw new Error("metadata keys must be strings");
        }
      }
    }

    if (expected !== undefined && output !== undefined) {
      throw new Error(
        "Only one of expected or output (deprecated) can be specified. Prefer expected.",
      );
    }

    if (tags) {
      validateTags(tags);
    }
  }

  private createArgs({
    id,
    input,
    expected,
    metadata,
    tags,
    output,
    isMerge,
  }: {
    id: string;
    input?: unknown;
    expected?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
    output?: unknown;
    isMerge?: boolean;
  }): LazyValue<BackgroundLogEvent> {
    return new LazyValue(async () => {
      const dataset_id = await this.id;
      const expectedValue = expected === undefined ? output : expected;

      const args: BackgroundLogEvent = {
        id,
        input,
        expected: expectedValue,
        tags,
        dataset_id,
        created: !isMerge ? new Date().toISOString() : undefined, //if we're merging/updating an event we will not add this ts
        metadata,
        ...(!!isMerge
          ? {
              [IS_MERGE_FIELD]: true,
            }
          : {}),
      };

      return args;
    });
  }

  /**
   * Insert a single record to the dataset. The record will be batched and uploaded behind the scenes. If you pass in an `id`,
   * and a record with that `id` already exists, it will be overwritten (upsert).
   *
   * @param event The event to log.
   * @param event.input The argument that uniquely define an input case (an arbitrary, JSON serializable object).
   * @param event.expected The output of your application, including post-processing (an arbitrary, JSON serializable object).
   * @param event.tags (Optional) a list of strings that you can use to filter and group records later.
   * @param event.metadata (Optional) a dictionary with additional data about the test example, model outputs, or just
   * about anything else that's relevant, that you can use to help find and analyze examples later. For example, you could log the
   * `prompt`, example's `id`, or anything else that would be useful to slice/dice later. The values in `metadata` can be any
   * JSON-serializable type, but its keys must be strings.
   * @param event.id (Optional) a unique identifier for the event. If you don't provide one, Braintrust will generate one for you.
   * @param event.output: (Deprecated) The output of your application. Use `expected` instead.
   * @returns The `id` of the logged record.
   */
  public insert({
    input,
    expected,
    metadata,
    tags,
    id,
    output,
  }: {
    readonly input?: unknown;
    readonly expected?: unknown;
    readonly tags?: string[];
    readonly metadata?: Record<string, unknown>;
    readonly id?: string;
    readonly output?: unknown;
  }): string {
    this.validateEvent({ metadata, expected, output, tags });

    const rowId = id || uuidv4();
    const args = this.createArgs(
      deepCopyEvent({
        id: rowId,
        input,
        expected,
        metadata,
        tags,
        output,
        isMerge: false,
      }),
    );

    this.state.bgLogger().log([args]);
    this.newRecords++;
    return rowId;
  }

  /**
   * Update fields of a single record in the dataset. The updated fields will be batched and uploaded behind the scenes.
   * You must pass in an `id` of the record to update. Only the fields provided will be updated; other fields will remain unchanged.
   *
   * @param event The fields to update in the record.
   * @param event.id The unique identifier of the record to update.
   * @param event.input (Optional) The new input value for the record (an arbitrary, JSON serializable object).
   * @param event.expected (Optional) The new expected output value for the record (an arbitrary, JSON serializable object).
   * @param event.tags (Optional) A list of strings to update the tags of the record.
   * @param event.metadata (Optional) A dictionary to update the metadata of the record. The values in `metadata` can be any
   * JSON-serializable type, but its keys must be strings.
   * @returns The `id` of the updated record.
   */
  public update({
    input,
    expected,
    metadata,
    tags,
    id,
  }: {
    readonly id: string;
    readonly input?: unknown;
    readonly expected?: unknown;
    readonly tags?: string[];
    readonly metadata?: Record<string, unknown>;
  }): string {
    this.validateEvent({ metadata, expected, tags });

    const args = this.createArgs(
      deepCopyEvent({
        id,
        input,
        expected,
        metadata,
        tags,
        isMerge: true,
      }),
    );

    this.state.bgLogger().log([args]);
    return id;
  }

  public delete(id: string): string {
    const args = new LazyValue(async () => ({
      id,
      dataset_id: await this.id,
      created: new Date().toISOString(),
      _object_delete: true,
    }));

    this.state.bgLogger().log([args]);
    return id;
  }

  /**
   * Summarize the dataset, including high level metrics about its size and other metadata.
   * @param summarizeData Whether to summarize the data. If false, only the metadata will be returned.
   * @returns `DatasetSummary`
   * @returns A summary of the dataset.
   */
  public async summarize(
    options: { readonly summarizeData?: boolean } = {},
  ): Promise<DatasetSummary> {
    const { summarizeData = true } = options || {};

    await this.flush();
    const state = await this.getState();
    const projectUrl = `${state.appPublicUrl}/app/${encodeURIComponent(
      state.orgName!,
    )}/p/${encodeURIComponent((await this.project).name)}`;
    const datasetUrl = `${projectUrl}/datasets/${encodeURIComponent(
      await this.name,
    )}`;

    let dataSummary: DataSummary | undefined;
    if (summarizeData) {
      const rawDataSummary = z
        .object({
          total_records: z.number(),
        })
        .parse(
          await state.apiConn().get_json(
            "dataset-summary",
            {
              dataset_id: await this.id,
            },
            3,
          ),
        );
      dataSummary = {
        newRecords: this.newRecords,
        totalRecords: rawDataSummary.total_records,
      };
    }

    return {
      projectName: (await this.project).name,
      datasetName: await this.name,
      projectUrl,
      datasetUrl,
      dataSummary,
    };
  }

  /**
   * Flush any pending rows to the server.
   */
  async flush(): Promise<void> {
    return await this.state.bgLogger().flush();
  }

  /**
   * @deprecated This function is deprecated. You can simply remove it from your code.
   */
  public async close(): Promise<string> {
    console.warn(
      "close is deprecated and will be removed in a future version of braintrust. It is now a no-op and can be removed",
    );
    return this.id;
  }

  public static isDataset(data: unknown): data is Dataset {
    return (
      typeof data === "object" &&
      data !== null &&
      "__braintrust_dataset_marker" in data
    );
  }
}

export type CompiledPromptParams = Omit<
  NonNullable<PromptData["options"]>["params"],
  "use_cache"
> & { model: NonNullable<NonNullable<PromptData["options"]>["model"]> };

export type ChatPrompt = {
  messages: OpenAIMessage[];
  tools?: ChatCompletionTool[];
};
export type CompletionPrompt = {
  prompt: string;
};

export type CompiledPrompt<Flavor extends "chat" | "completion"> =
  CompiledPromptParams & {
    span_info?: {
      name?: string;
      spanAttributes?: Record<any, any>;
      metadata: {
        prompt: {
          variables: Record<string, unknown>;
          id: string;
          project_id: string;
          version: string;
        };
      };
    };
  } & (Flavor extends "chat"
      ? ChatPrompt
      : Flavor extends "completion"
        ? CompletionPrompt
        : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
          {});

export type DefaultPromptArgs = Partial<
  CompiledPromptParams & AnyModelParam & ChatPrompt & CompletionPrompt
>;

function isAttachmentObject(value: unknown): boolean {
  return (
    BraintrustAttachmentReferenceSchema.safeParse(value).success ||
    InlineAttachmentReferenceSchema.safeParse(value).success ||
    ExternalAttachmentReferenceSchema.safeParse(value).success
  );
}

// Simple URL validation all braintrust attachment urls or generic links
function isURL(url: string): boolean {
  try {
    const parsedUrl = new URL(url.trim());
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Detect and expand attachment array variables before template rendering.
 * Supports both simple variables ({{images}}) and nested paths ({{data.images}}).
 * @param content The message content (should be a template variable like "{{images}}" or "{{data.images}}")
 * @param variables The variables object with array values
 * @returns Array of image_url parts if expansion occurred, null otherwise
 */
function expandAttachmentArrayPreTemplate(
  content: unknown,
  variables: Record<string, unknown>,
): unknown[] | null {
  if (typeof content !== "string") return null;

  // Detect {{varName}} or {{nested.path}} pattern (exact match only - no mixed content)
  // Supports: {{images}}, {{data.images}}, {{user.profile.images}}, etc.
  const match = content.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (!match) return null;

  const varPath = match[1];

  const value = varPath.includes(".")
    ? getObjValueByPath(variables, varPath.split("."))
    : variables[varPath];

  if (!Array.isArray(value)) return null;

  // Check if array contains attachments or image URLs
  const allValid = value.every(
    (v) => isAttachmentObject(v) || (typeof v === "string" && isURL(v)),
  );

  if (!allValid) return null;

  // Expand directly to image_url parts
  return value.map((item) => ({
    type: "image_url" as const,
    image_url: { url: item },
  }));
}

export function renderMessage<T extends Message>(
  render: (template: string) => string,
  message: T,
): T;

export function renderMessage<T extends Message>(
  render: (template: string) => string,
  message: T,
): T {
  return renderMessageImpl(render, message, {});
}

export function renderMessageImpl<T extends Message>(
  render: (template: string) => string,
  message: T,
  variables?: Record<string, unknown>,
): T {
  return {
    ...message,
    ...("content" in message
      ? {
          content: isEmpty(message.content)
            ? undefined
            : typeof message.content === "string"
              ? render(message.content)
              : message.content.flatMap((c) => {
                  switch (c.type) {
                    case "text":
                      return [{ ...c, text: render(c.text) }];
                    case "image_url":
                      if (isObject(c.image_url.url)) {
                        throw new Error(
                          "Attachments must be replaced with URLs before calling `build()`",
                        );
                      }

                      if (variables) {
                        const expanded = expandAttachmentArrayPreTemplate(
                          c.image_url.url,
                          variables,
                        );
                        if (expanded) {
                          return expanded;
                        }
                      }

                      // Otherwise render the URL template normally
                      return [
                        {
                          ...c,
                          image_url: {
                            ...c.image_url,
                            url: render(c.image_url.url),
                          },
                        },
                      ];
                    case "file":
                      return [
                        {
                          ...c,
                          file: {
                            ...(c.file.file_data && {
                              file_data: render(c.file.file_data),
                            }),
                            ...(c.file.file_id && {
                              file_id: render(c.file.file_id),
                            }),
                            ...(c.file.filename && {
                              filename: render(c.file.filename),
                            }),
                          },
                        },
                      ];
                    default:
                      const _exhaustiveCheck: never = c;
                      return _exhaustiveCheck;
                  }
                }),
        }
      : {}),
    ...("tool_calls" in message
      ? {
          tool_calls: isEmpty(message.tool_calls)
            ? undefined
            : message.tool_calls.map((t) => {
                return {
                  type: t.type,
                  id: render(t.id),
                  function: {
                    name: render(t.function.name),
                    arguments: render(t.function.arguments),
                  },
                };
              }),
        }
      : {}),
    ...("tool_call_id" in message
      ? {
          tool_call_id: render(message.tool_call_id),
        }
      : {}),
  };
}

export type PromptRowWithId<
  HasId extends boolean = true,
  HasVersion extends boolean = true,
> = Omit<PromptRow, "log_id" | "org_id" | "project_id" | "id" | "_xact_id"> &
  Partial<Pick<PromptRow, "project_id">> &
  (HasId extends true
    ? Pick<PromptRow, "id">
    : Partial<Pick<PromptRow, "id">>) &
  (HasVersion extends true
    ? Pick<PromptRow, "_xact_id">
    : Partial<Pick<PromptRow, "_xact_id">>);

export function deserializePlainStringAsJSON(s: string) {
  if (s.trim() === "") {
    return { value: null, error: undefined };
  }

  try {
    return { value: JSON.parse(s), error: undefined };
  } catch (e) {
    return { value: s, error: e };
  }
}

function renderTemplatedObject(
  obj: unknown,
  args: Record<string, unknown>,
  options: { strict?: boolean; templateFormat: TemplateFormat },
): unknown {
  if (typeof obj === "string") {
    return renderTemplateContent(
      obj,
      args,
      (value) => (typeof value === "string" ? value : JSON.stringify(value)),
      {
        strict: options.strict,
        templateFormat: options.templateFormat,
      },
    );
  } else if (isArray(obj)) {
    return obj.map((item) => renderTemplatedObject(item, args, options));
  } else if (isObject(obj)) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key,
        renderTemplatedObject(value, args, options),
      ]),
    );
  }
  return obj;
}

export function renderPromptParams(
  params: ModelParams | undefined,
  args: Record<string, unknown>,
  options: { strict?: boolean; templateFormat?: TemplateFormat } = {},
): ModelParams | undefined {
  const templateFormat = parseTemplateFormat(options.templateFormat);
  const strict = !!options.strict;

  const schemaParsed = z
    .object({
      response_format: z.object({
        type: z.literal("json_schema"),
        json_schema: responseFormatJsonSchemaSchema
          .omit({ schema: true })
          .extend({
            schema: z.unknown(),
          }),
      }),
    })
    .safeParse(params);
  if (schemaParsed.success) {
    const rawSchema = schemaParsed.data.response_format.json_schema.schema;
    const templatedSchema = renderTemplatedObject(rawSchema, args, {
      strict,
      templateFormat,
    });
    const parsedSchema =
      typeof templatedSchema === "string"
        ? deserializePlainStringAsJSON(templatedSchema).value
        : templatedSchema;

    return {
      ...params,
      response_format: {
        ...schemaParsed.data.response_format,
        json_schema: {
          ...schemaParsed.data.response_format.json_schema,
          schema: parsedSchema,
        },
      },
    };
  }
  return params;
}

export class Prompt<
  HasId extends boolean = true,
  HasVersion extends boolean = true,
> {
  private parsedPromptData: PromptData | undefined;
  private hasParsedPromptData = false;
  private readonly __braintrust_prompt_marker = true;

  constructor(
    private metadata: PromptRowWithId<HasId, HasVersion> | PromptSessionEvent,
    private defaults: DefaultPromptArgs,
    private noTrace: boolean,
  ) {}

  public get id(): HasId extends true ? string : string | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.metadata.id as HasId extends true ? string : string | undefined;
  }

  public get projectId(): string | undefined {
    return this.metadata.project_id;
  }

  public get name(): string {
    return "name" in this.metadata
      ? this.metadata.name
      : `Playground function ${this.metadata.id}`;
  }

  public get slug(): string {
    return "slug" in this.metadata ? this.metadata.slug : this.metadata.id;
  }

  public get prompt(): PromptData["prompt"] {
    return this.getParsedPromptData()?.prompt;
  }

  public get version(): HasId extends true
    ? TransactionId
    : TransactionId | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.metadata[TRANSACTION_ID_FIELD] as HasId extends true
      ? TransactionId
      : TransactionId | undefined;
  }

  public get options(): NonNullable<PromptData["options"]> {
    return this.getParsedPromptData()?.options || {};
  }

  public get templateFormat(): string | null | undefined {
    return this.getParsedPromptData()?.template_format;
  }

  public get promptData(): PromptData {
    return this.getParsedPromptData()!;
  }

  /**
   * Build the prompt with the given formatting options. The args you pass in will
   * be forwarded to the mustache template that defines the prompt and rendered with
   * the `mustache-js` library.
   *
   * @param buildArgs Args to forward along to the prompt template.
   */
  public build<Flavor extends "chat" | "completion" = "chat">(
    buildArgs: unknown,
    options: {
      flavor?: Flavor;
      messages?: Message[];
      strict?: boolean;
      templateFormat?: TemplateFormat;
    } = {},
  ): CompiledPrompt<Flavor> {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.runBuild(buildArgs, {
      flavor: options.flavor ?? "chat",
      messages: options.messages,
      strict: options.strict,
      templateFormat: options.templateFormat,
    }) as CompiledPrompt<Flavor>;
  }

  /**
   * This is a special build method that first resolves attachment references, and then
   * calls the regular build method. You should use this if you are building prompts from
   * dataset rows that contain attachments.
   *
   * @param buildArgs Args to forward along to the prompt template.
   */
  public async buildWithAttachments<
    Flavor extends "chat" | "completion" = "chat",
  >(
    buildArgs: unknown,
    options: {
      flavor?: Flavor;
      messages?: Message[];
      strict?: boolean;
      state?: BraintrustState;
      templateFormat?: TemplateFormat;
    } = {},
  ): Promise<CompiledPrompt<Flavor>> {
    const hydrated =
      buildArgs instanceof Object
        ? await resolveAttachmentsToBase64(buildArgs, options.state)
        : buildArgs;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.runBuild(hydrated, {
      flavor: options.flavor ?? "chat",
      messages: options.messages,
      strict: options.strict,
      templateFormat: options.templateFormat,
    }) as CompiledPrompt<Flavor>;
  }

  private runBuild<Flavor extends "chat" | "completion">(
    buildArgs: unknown,
    options: {
      flavor: Flavor;
      messages?: Message[];
      strict?: boolean;
      templateFormat?: TemplateFormat;
    },
  ): CompiledPrompt<Flavor> {
    const { flavor } = options;

    const params = {
      ...this.defaults,
      ...Object.fromEntries(
        Object.entries(this.options.params || {}).filter(
          ([k, _v]) => !BRAINTRUST_PARAMS.includes(k),
        ),
      ),
      ...(!isEmpty(this.options.model)
        ? {
            model: this.options.model,
          }
        : {}),
    };

    if (!("model" in params) || isEmpty(params.model)) {
      throw new Error(
        "No model specified. Either specify it in the prompt or as a default",
      );
    }

    const spanInfo = this.noTrace
      ? {}
      : {
          span_info: {
            metadata: {
              prompt: this.id
                ? {
                    variables: buildArgs,
                    id: this.id,
                    project_id: this.projectId,
                    version: this.version,
                    ...("prompt_session_id" in this.metadata
                      ? { prompt_session_id: this.metadata.prompt_session_id }
                      : {}),
                  }
                : undefined,
            },
          },
        };

    const prompt = this.prompt;

    if (!prompt) {
      throw new Error("Empty prompt");
    }

    const dictArgParsed = z.record(z.unknown()).safeParse(buildArgs);
    const variables: Record<string, unknown> = {
      input: buildArgs,
      ...(dictArgParsed.success ? dictArgParsed.data : {}),
    };

    // Use template_format from prompt data if available, otherwise fall back to the option or default to mustache
    const promptDataTemplateFormat = this.templateFormat;
    const resolvedTemplateFormat = parseTemplateFormat(
      options.templateFormat ?? promptDataTemplateFormat,
    );

    const renderedPrompt = Prompt.renderPrompt({
      prompt,
      buildArgs,
      options: { ...options, templateFormat: resolvedTemplateFormat },
    });

    if (flavor === "chat") {
      if (renderedPrompt.type !== "chat") {
        throw new Error(
          "Prompt is a completion prompt. Use buildCompletion() instead",
        );
      }

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return {
        ...renderPromptParams(params, variables, {
          strict: options.strict,
          templateFormat: resolvedTemplateFormat,
        }),
        ...spanInfo,
        messages: renderedPrompt.messages,
        ...(renderedPrompt.tools
          ? {
              tools: chatCompletionToolSchema
                .array()
                .parse(JSON.parse(renderedPrompt.tools)),
            }
          : undefined),
      } as CompiledPrompt<Flavor>;
    } else if (flavor === "completion") {
      if (renderedPrompt.type !== "completion") {
        throw new Error(`Prompt is a chat prompt. Use flavor: 'chat' instead`);
      }

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return {
        ...renderPromptParams(params, variables, {
          strict: options.strict,
          templateFormat: resolvedTemplateFormat,
        }),
        ...spanInfo,
        prompt: renderedPrompt.content,
      } as CompiledPrompt<Flavor>;
    } else {
      throw new Error("never!");
    }
  }

  static renderPrompt({
    prompt,
    buildArgs,
    options,
  }: {
    prompt: PromptBlockData;
    buildArgs: unknown;
    options: {
      strict?: boolean;
      messages?: Message[];
      templateFormat?: TemplateFormat;
    };
  }): PromptBlockData {
    const escape = (v: unknown) => {
      if (v === undefined) {
        throw new Error("Missing!");
      } else if (typeof v === "string") {
        return v;
      } else if (v instanceof ReadonlyAttachment) {
        throw new Error(
          "Use buildWithAttachments() to build prompts with attachments",
        );
      } else {
        return JSON.stringify(v);
      }
    };

    const dictArgParsed = z.record(z.unknown()).safeParse(buildArgs);
    const variables: Record<string, unknown> = {
      input: buildArgs,
      ...(dictArgParsed.success ? dictArgParsed.data : {}),
    };

    const templateFormat = parseTemplateFormat(options.templateFormat);

    if (prompt.type === "chat") {
      const render = (template: string) =>
        renderTemplateContent(template, variables, escape, {
          strict: options.strict,
          templateFormat: templateFormat,
        });

      const baseMessages = (prompt.messages || []).map((m) =>
        renderMessageImpl(render, m, variables),
      );
      const hasSystemPrompt = baseMessages.some((m) => m.role === "system");

      const messages: Message[] = [
        ...baseMessages,
        ...(options.messages ?? []).filter(
          (m) => !(hasSystemPrompt && m.role === "system"),
        ),
      ];

      return {
        type: "chat",
        messages: messages,
        ...(prompt.tools?.trim()
          ? {
              tools: render(prompt.tools),
            }
          : undefined),
      };
    } else if (prompt.type === "completion") {
      if (options.messages) {
        throw new Error(
          "extra messages are not supported for completion prompts",
        );
      }

      const content = renderTemplateContent(prompt.content, variables, escape, {
        strict: options.strict,
        templateFormat: templateFormat,
      });
      return {
        type: "completion",
        content,
      };
    } else {
      const _: never = prompt;
      throw new Error(`Invalid prompt type: ${_}`);
    }
  }

  private getParsedPromptData(): PromptData | undefined {
    if (!this.hasParsedPromptData) {
      this.parsedPromptData = promptDataSchema.parse(this.metadata.prompt_data);
      this.hasParsedPromptData = true;
    }
    return this.parsedPromptData!;
  }

  public static isPrompt(data: unknown): data is Prompt<boolean, boolean> {
    return (
      typeof data === "object" &&
      data !== null &&
      "__braintrust_prompt_marker" in data
    );
  }
  public static fromPromptData(
    name: string,
    promptData: PromptData,
  ): Prompt<false, false> {
    return new Prompt(
      {
        name: name,
        slug: name,
        prompt_data: promptData,
      },
      {},
      false,
    );
  }
}

export class RemoteEvalParameters<
  HasId extends boolean = true,
  HasVersion extends boolean = true,
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  private readonly __braintrust_parameters_marker = true;

  constructor(private metadata: ParametersRow) {}

  public get id(): HasId extends true ? string : string | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.metadata.id as HasId extends true ? string : string | undefined;
  }

  public get projectId(): string | undefined {
    return this.metadata.project_id;
  }

  public get name(): string {
    return this.metadata.name;
  }

  public get slug(): string {
    return this.metadata.slug;
  }

  public get version(): HasVersion extends true
    ? TransactionId
    : TransactionId | undefined {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return this.metadata[TRANSACTION_ID_FIELD] as HasVersion extends true
      ? TransactionId
      : TransactionId | undefined;
  }

  public get schema(): Record<string, unknown> {
    return this.metadata.function_data.__schema;
  }

  public get data(): T {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return (this.metadata.function_data.data ?? {}) as T;
  }

  public validate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) {
      return false;
    }
    const schemaProps = this.schema.properties;
    if (typeof schemaProps !== "object" || schemaProps === null) {
      return true;
    }
    for (const key of Object.keys(schemaProps)) {
      if (!(key in data)) {
        const required = Array.isArray(this.schema.required)
          ? this.schema.required
          : [];
        if (required.includes(key)) {
          return false;
        }
      }
    }
    return true;
  }

  public static isParameters(
    x: unknown,
  ): x is RemoteEvalParameters<boolean, boolean, Record<string, unknown>> {
    return (
      typeof x === "object" &&
      x !== null &&
      "__braintrust_parameters_marker" in x &&
      x.__braintrust_parameters_marker === true
    );
  }
}

export type AnyDataset = Dataset<boolean>;

/**
 * Summary of a score's performance.
 * @property name Name of the score.
 * @property score Average score across all examples.
 * @property diff Difference in score between the current and reference experiment.
 * @property improvements Number of improvements in the score.
 * @property regressions Number of regressions in the score.
 */
export interface ScoreSummary {
  name: string;
  score: number;
  diff?: number;
  improvements: number;
  regressions: number;
}

/**
 * Summary of a metric's performance.
 * @property name Name of the metric.
 * @property metric Average metric across all examples.
 * @property unit Unit label for the metric.
 * @property diff Difference in metric between the current and reference experiment.
 * @property improvements Number of improvements in the metric.
 * @property regressions Number of regressions in the metric.
 */
export interface MetricSummary {
  name: string;
  metric: number;
  unit: string;
  diff?: number;
  improvements: number;
  regressions: number;
}

/**
 * Summary of an experiment's scores and metadata.
 * @property projectName Name of the project that the experiment belongs to.
 * @property experimentName Name of the experiment.
 * @property experimentId ID of the experiment. May be `undefined` if the eval was run locally.
 * @property projectUrl URL to the project's page in the Braintrust app.
 * @property experimentUrl URL to the experiment's page in the Braintrust app.
 * @property comparisonExperimentName The experiment scores are baselined against.
 * @property scores Summary of the experiment's scores.
 */
export interface ExperimentSummary {
  projectName: string;
  experimentName: string;
  projectId?: string;
  experimentId?: string;
  projectUrl?: string;
  experimentUrl?: string;
  comparisonExperimentName?: string;
  scores: Record<string, ScoreSummary>;
  metrics?: Record<string, MetricSummary>;
}

/**
 * Summary of a dataset's data.
 *
 * @property totalRecords Total records in the dataset.
 */
export interface DataSummary {
  /**
   * New or updated records added in this session.
   */
  newRecords: number;
  /**
   * Total records in the dataset.
   */
  totalRecords: number;
}

/**
 * Summary of a dataset's scores and metadata.
 *
 * @property projectName Name of the project that the dataset belongs to.
 * @property datasetName Name of the dataset.
 * @property projectUrl URL to the project's page in the Braintrust app.
 * @property datasetUrl URL to the experiment's page in the Braintrust app.
 * @property dataSummary Summary of the dataset's data.
 */
export interface DatasetSummary {
  projectName: string;
  datasetName: string;
  projectUrl: string;
  datasetUrl: string;
  dataSummary: DataSummary | undefined;
}

/**
 * Allows accessing helper functions for testing.
 * @internal
 */

// it's used to circumvent login for testing, but won't actually work
// on the server side.
const TEST_API_KEY = "___TEST_API_KEY__THIS_IS_NOT_REAL___";

function setInitialTestState() {
  // a way of setting initial state for tests without any log messages
  if (!_internalGetGlobalState()) {
    _internalSetInitialState();
  }
}
// This is a helper function to simulate a login for testing.
async function simulateLoginForTests() {
  return await login({
    apiKey: TEST_API_KEY,
    appUrl: "https://braintrust.dev",
  });
}

// This is a helper function to simulate a logout for testing.
function simulateLogoutForTests() {
  const state = _internalGetGlobalState();
  state.resetLoginInfo();
  state.appUrl = "https://www.braintrust.dev";
  return state;
}

/**
 * Get the versions for a prompt.
 *
 * @param projectId The ID of the project to query
 * @param promptId The ID of the prompt to get versions for
 * @returns Promise containing the version data
 */
export async function getPromptVersions(
  projectId: string,
  promptId: string,
): Promise<any> {
  const state = _internalGetGlobalState();
  if (!state) {
    throw new Error("Must log in first");
  }

  await state.login({});

  const query = {
    from: {
      op: "function",
      name: {
        op: "ident",
        name: ["project_prompts"],
      },
      args: [
        {
          op: "literal",
          value: projectId,
        },
      ],
    },
    select: [
      {
        op: "star",
      },
    ],
    filter: {
      op: "eq",
      left: { op: "ident", name: ["id"] },
      right: { op: "literal", value: promptId },
    },
  };

  const response = await state.apiConn().post(
    "btql",
    {
      query,
      audit_log: true,
      use_columnstore: false,
      brainstore_realtime: true,
    },
    { headers: { "Accept-Encoding": "gzip" } },
  );

  if (!response.ok) {
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const result = await response.json();

  // Filter for entries where audit_data.action is "upsert" or "merge" and return only _xact_id fields
  return (
    result.data
      ?.filter((entry: any) =>
        ["upsert", "merge"].includes(entry.audit_data?.action),
      )
      .map((entry: any) => prettifyXact(entry._xact_id)) || []
  );
}

// Helper function to reset ID generator state for testing
function resetIdGenStateForTests() {
  const state = _internalGetGlobalState();
  if (state) {
    state.resetIdGenState();
  }
}

export const _exportsForTestingOnly = {
  extractAttachments,
  deepCopyEvent,
  useTestBackgroundLogger,
  clearTestBackgroundLogger,
  simulateLoginForTests,
  simulateLogoutForTests,
  setInitialTestState,
  initTestExperiment,
  isGeneratorFunction,
  isAsyncGeneratorFunction,
  resetIdGenStateForTests,
  validateTags,
  isomorph: iso, // Expose isomorph for build type detection
};
