export type OpenAIBatchJSONL =
  | string
  | Iterable<unknown>
  | AsyncIterable<unknown>;

export type OpenAIBatchFileContent = OpenAIBatchJSONL | Response;

export type OpenAIBatchFile =
  | OpenAIBatchFileContent
  | PromiseLike<OpenAIBatchFileContent>;

export interface OpenAIFileLike {
  id: string;
  [key: string]: unknown;
}

export interface OpenAIBatchLike {
  id: string;
  endpoint: string;
  input_file_id: string;
  status: string;
  created_at?: number | null;
  in_progress_at?: number | null;
  completed_at?: number | null;
  failed_at?: number | null;
  expired_at?: number | null;
  cancelled_at?: number | null;
  request_counts?: {
    completed?: number;
    failed?: number;
    total?: number;
  } | null;
  [key: string]: unknown;
}

export type OpenAIEnhancedResponse<T> = {
  response: Response;
  data: T;
  request_id?: string | null;
};

export interface OpenAIAPIPromise<T> extends Promise<T> {
  withResponse(): Promise<OpenAIEnhancedResponse<T>>;
  asResponse(): Promise<Response>;
}

export interface OpenAIFilesResource<TParams, TFile, TOptions> {
  create(params: TParams, options?: TOptions): OpenAIAPIPromise<TFile>;
}

export interface OpenAIBatchesResource<TBatch, TOptions> {
  retrieve(batchId: string, options?: TOptions): OpenAIAPIPromise<TBatch>;
}

export interface OpenAIFilesCreateTraceArgs {
  inputFileContent: OpenAIBatchFileContent;
  parent: { export(): Promise<string> } | { toStr(): string };
  params: unknown;
}

export interface OpenAIBatchesRetrieveTraceArgs {
  batchId: string;
}

export interface CompleteOpenAIBatchTraceArgs {
  inputFileId: string;
  inputFileContent: OpenAIBatchFile;
  outputFileContent?: OpenAIBatchFile;
  errorFileContent?: OpenAIBatchFile;
}
