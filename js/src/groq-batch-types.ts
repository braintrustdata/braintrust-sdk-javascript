export type GroqBatchJSONL =
  | string
  | Iterable<unknown>
  | AsyncIterable<unknown>;

export type GroqBatchReplayableJSONL =
  | string
  | (() => Iterable<unknown> | AsyncIterable<unknown>);

type GroqBatchFileContent = GroqBatchJSONL | Response;

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
