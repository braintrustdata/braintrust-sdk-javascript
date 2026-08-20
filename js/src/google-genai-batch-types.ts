export type GeminiDeveloperBatchJSONL =
  | string
  | Uint8Array
  | Response
  | Iterable<unknown>
  | AsyncIterable<unknown>;

export type GeminiDeveloperBatchFile =
  | GeminiDeveloperBatchJSONL
  | PromiseLike<GeminiDeveloperBatchJSONL>;

export type GeminiDeveloperBatchTraceContext = string;

export interface GeminiDeveloperInlinedBatchRequest {
  model?: string;
  contents?: unknown;
  config?: unknown;
  metadata?: Record<string, string>;
}

export interface GeminiDeveloperBatchSourceConfig {
  fileName?: string;
  inlinedRequests?: GeminiDeveloperInlinedBatchRequest[];
}

export type GeminiDeveloperBatchSource =
  | string
  | GeminiDeveloperInlinedBatchRequest[]
  | GeminiDeveloperBatchSourceConfig;

export interface GeminiDeveloperBatchCreateParams {
  model?: string;
  src: GeminiDeveloperBatchSource;
  config?: unknown;
}

export interface GeminiDeveloperBatchResult {
  response?: unknown;
  error?: {
    code?: number;
    message?: string;
    details?: unknown;
  };
  metadata?: unknown;
}

export interface GeminiDeveloperBatchLike {
  name?: string;
  displayName?: string;
  state?: string;
  error?: GeminiDeveloperBatchResult["error"];
  createTime?: string;
  startTime?: string;
  endTime?: string;
  updateTime?: string;
  model?: string;
  dest?: {
    fileName?: string;
    inlinedResponses?: GeminiDeveloperBatchResult[];
  };
  completionStats?: {
    failedCount?: string;
    incompleteCount?: string;
    successfulCount?: string;
  };
}

export interface StartGeminiDeveloperBatchTraceArgs<
  TBatch extends GeminiDeveloperBatchLike,
> {
  batch: TBatch;
  params: GeminiDeveloperBatchCreateParams;
  /**
   * Required for file-backed batches. Omit for inline batches. Pass text,
   * bytes, or a replayable iterable when the source is a `Response`; tracing
   * never consumes caller-owned response bodies.
   */
  input?: GeminiDeveloperBatchFile;
}

export interface CompleteGeminiDeveloperBatchTraceArgs<
  TBatch extends GeminiDeveloperBatchLike,
> {
  batch: TBatch;
  params: GeminiDeveloperBatchCreateParams;
  /**
   * Context returned by `startGeminiDeveloperBatchTrace`. When omitted or
   * invalid, completion creates a collect-only trace under the active
   * Braintrust parent.
   */
  traceContext?: GeminiDeveloperBatchTraceContext;
  /**
   * Required for file-backed batches. Omit for inline batches. Pass text,
   * bytes, or a replayable iterable when the source is a `Response`; tracing
   * never consumes caller-owned response bodies.
   */
  input?: GeminiDeveloperBatchFile;
  /** Required for a successful file-backed batch. */
  outputFile?: GeminiDeveloperBatchFile;
}

export interface CompleteGeminiDeveloperBatchTraceResult<
  TBatch extends GeminiDeveloperBatchLike,
> {
  /** The exact provider batch object supplied to the completion helper. */
  batch: TBatch;
  /**
   * Opaque resumable context for subsequent collection attempts. Persist this
   * value when completion was first performed without start context.
   */
  traceContext?: GeminiDeveloperBatchTraceContext;
}
