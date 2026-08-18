export type OpenAIBatchJSONL =
  | string
  | Iterable<unknown>
  | AsyncIterable<unknown>;

type OpenAIBatchFileContent = OpenAIBatchJSONL | Response;

type OpenAIBatchFile =
  | OpenAIBatchFileContent
  | PromiseLike<OpenAIBatchFileContent>;

type SupportedOpenAIBatchEndpoint = "/v1/chat/completions" | "/v1/responses";

export interface OpenAIBatchLike {
  id: string;
  endpoint: string;
  input_file_id: string;
  status: string;
  completed_at?: number | null;
  failed_at?: number | null;
  expired_at?: number | null;
  cancelled_at?: number | null;
  metadata?: Record<string, string> | null;
  request_counts?: {
    completed?: number;
    failed?: number;
    total?: number;
  } | null;
  [key: string]: unknown;
}

export interface OpenAIBatchCreateParams {
  input_file_id: string;
  endpoint: SupportedOpenAIBatchEndpoint;
  completion_window: "24h";
  metadata?: Record<string, string> | null;
  [key: string]: unknown;
}

export interface OpenAIBatchCreateInputParams {
  endpoint: SupportedOpenAIBatchEndpoint;
  completion_window: "24h";
  metadata?: Record<string, string> | null;
  [key: string]: unknown;
}

export interface OpenAIFileLike {
  id: string;
  [key: string]: unknown;
}

export interface OpenAIBatchWebhookEvent {
  type:
    | "batch.completed"
    | "batch.failed"
    | "batch.expired"
    | "batch.cancelled";
  created_at?: number;
  data: { id: string };
  [key: string]: unknown;
}

export interface StartOpenAIBatchTraceArgs {
  inputFile: OpenAIFileLike;
  input: OpenAIBatchJSONL;
  params: OpenAIBatchCreateInputParams;
}

export interface CompleteOpenAIBatchTraceArgs<TBatch extends OpenAIBatchLike> {
  batch: TBatch;
  inputFile: OpenAIBatchFile;
  outputFile?: OpenAIBatchFile;
  errorFile?: OpenAIBatchFile;
  webhook?: OpenAIBatchWebhookEvent;
}
