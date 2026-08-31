export type GroqBatchJSONL =
  | string
  | Iterable<unknown>
  | AsyncIterable<unknown>;

export type GroqBatchFileContent = GroqBatchJSONL | Response;

export type GroqBatchReplayableJSONL = string | (() => GroqBatchFileContent);

export type GroqBatchFileFactory = () =>
  | GroqBatchFileContent
  | PromiseLike<GroqBatchFileContent>;

export type GroqBatchFile =
  | GroqBatchFileContent
  | GroqBatchFileFactory
  | PromiseLike<GroqBatchFileContent | GroqBatchFileFactory>;

export interface GroqBatchLike {
  id: string;
  endpoint: string;
  input_file_id: string;
  status: string;
  created_at?: number | null;
  completed_at?: number | null;
  failed_at?: number | null;
  expired_at?: number | null;
  cancelled_at?: number | null;
  metadata?: unknown | null;
  request_counts?: {
    completed?: number;
    failed?: number;
    total?: number;
  } | null;
  [key: string]: unknown;
}

export type GroqEnhancedResponse<T> = {
  response: Response;
  data: T;
  request_id?: string | null;
};

export interface GroqAPIPromise<T> extends Promise<T> {
  withResponse(): Promise<GroqEnhancedResponse<T>>;
  asResponse(): Promise<Response>;
}

export interface GroqFilesResource<TParams, TFile, TOptions> {
  create(params: TParams, options?: TOptions): GroqAPIPromise<TFile>;
}

export interface GroqBatchesCreateResource<TParams, TBatch, TOptions> {
  create(params: TParams, options?: TOptions): GroqAPIPromise<TBatch>;
}

export interface GroqBatchesRetrieveResource<TBatch, TOptions> {
  retrieve(batchId: string, options?: TOptions): GroqAPIPromise<TBatch>;
}

export interface GroqFilesCreateTraceArgs {
  inputFileContent: Response;
  parent: { export(): Promise<string> } | { toStr(): string };
}

export interface GroqBatchesCreateTraceArgs {
  params: unknown;
}

export interface GroqBatchesRetrieveTraceArgs {
  batchId: string;
}

export interface CompleteGroqBatchTraceArgs<TBatch extends GroqBatchLike> {
  batch: TBatch;
  inputFileContent: GroqBatchFile;
  outputFileContent?: GroqBatchFile;
  errorFileContent?: GroqBatchFile;
}

export interface GroqBatchCreateParams {
  input_file_id: string;
  endpoint: "/v1/chat/completions";
  completion_window: string;
  metadata?: Record<string, string> | null;
}

export interface GroqBatchCreateInputParams {
  endpoint: "/v1/chat/completions";
  completion_window: string;
  metadata?: Record<string, string> | null;
}

export interface GroqFileLike {
  id: string;
}

export interface StartGroqBatchTraceArgs {
  inputFile: GroqFileLike;
  input: GroqBatchReplayableJSONL;
  params: GroqBatchCreateInputParams;
}

export interface GroqBatchTraceContext {
  readonly value: string;
}

export interface BindGroqBatchTraceArgs<TBatch extends GroqBatchLike> {
  batch: TBatch;
}

export interface CollectGroqBatchTraceArgs<TBatch extends GroqBatchLike> {
  batch: TBatch;
  traceContext?: GroqBatchTraceContext;
  inputFile: GroqBatchFile;
  outputFile?: GroqBatchFile;
  errorFile?: GroqBatchFile;
}

export interface FailGroqBatchTraceArgs {
  params: GroqBatchCreateParams;
  input: GroqBatchReplayableJSONL;
  error: unknown;
}
