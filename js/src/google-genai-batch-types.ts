export type GeminiDeveloperBatchJSONL =
  | string
  | Uint8Array
  | Response
  | Iterable<unknown>
  | AsyncIterable<unknown>;

export type GeminiDeveloperBatchFile =
  | GeminiDeveloperBatchJSONL
  | PromiseLike<GeminiDeveloperBatchJSONL>;

export interface GeminiDeveloperInlinedBatchRequest {
  model?: string;
  contents?: unknown;
  config?: unknown;
  metadata?: Record<string, string>;
}

export type GeminiDeveloperBatchSource =
  | string
  | GeminiDeveloperInlinedBatchRequest[]
  | {
      fileName?: string;
      inlinedRequests?: GeminiDeveloperInlinedBatchRequest[];
    };

export interface GeminiDeveloperBatchCreateParams {
  model?: string;
  src: GeminiDeveloperBatchSource;
  config?: unknown;
}

export interface GeminiDeveloperBatchGetParams {
  name: string;
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

export interface GoogleGenAIBatchesCreateTraceOptions {
  /**
   * The original JSONL content for a file-backed batch. Inline requests are
   * read directly from `params.src`.
   */
  inputFileContent?: GeminiDeveloperBatchFile;
}

export interface GoogleGenAIBatchesCreateTraceArgs {
  params: GeminiDeveloperBatchCreateParams;
  inputFileContent?: GeminiDeveloperBatchFile;
  parent: { export(): Promise<string> } | { toStr(): string };
}

export interface GoogleGenAIBatchesGetTraceArgs {
  params: GeminiDeveloperBatchGetParams;
}

export interface CompleteGoogleGenAIBatchTraceArgs<
  TBatch extends GeminiDeveloperBatchLike = GeminiDeveloperBatchLike,
> {
  batch: TBatch;
  /**
   * Original inline requests. Supply these only when collecting in a process
   * that did not call `googleGenAIBatchesCreateTraced`.
   */
  inlinedRequests?: GeminiDeveloperInlinedBatchRequest[];
  /**
   * Original JSONL input. Supply this when starting or collecting a
   * file-backed trace outside the process that traced batch creation.
   */
  inputFileContent?: GeminiDeveloperBatchFile;
  /** Required for a successful file-backed batch. */
  outputFileContent?: GeminiDeveloperBatchFile;
}

export interface GoogleGenAIBatchesCreateResource<
  TParams,
  TBatch extends GeminiDeveloperBatchLike,
> {
  create(params: TParams): Promise<TBatch>;
}

export interface GoogleGenAIBatchesGetResource<
  TParams,
  TBatch extends GeminiDeveloperBatchLike,
> {
  get(params: TParams): Promise<TBatch>;
}
