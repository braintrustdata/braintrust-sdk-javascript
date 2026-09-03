type MistralBatchJSONLContent =
  | string
  | Iterable<unknown>
  | AsyncIterable<unknown>
  | ReadableStream<Uint8Array>
  | Response;

export type MistralBatchJSONLSource =
  | MistralBatchJSONLContent
  | PromiseLike<MistralBatchJSONLContent>;

export type MistralBatchInputFileContent =
  | MistralBatchJSONLSource
  | (() => MistralBatchJSONLSource);

export interface MistralBatchFileLike {
  id: string;
}

export interface MistralBatchRequestLike {
  customId: string;
  body: Record<string, unknown>;
}

export type MistralBatchInput =
  | {
      files: ReadonlyArray<{
        file: MistralBatchFileLike;
        content: MistralBatchInputFileContent;
      }>;
    }
  | { requests: ReadonlyArray<MistralBatchRequestLike> };

interface MistralBatchCreateParamsBase {
  endpoint: "/v1/chat/completions";
  metadata?: Record<string, string> | null;
  timeoutHours?: number;
}

export type MistralBatchCreateParams = MistralBatchCreateParamsBase &
  ({ model: string; agentId?: never } | { agentId: string; model?: never }) & {
    inputFiles?: string[] | null;
    requests?: MistralBatchRequestLike[] | null;
  };

export interface MistralBatchLike {
  id: string;
  endpoint: string;
  status: string;
  model?: string | null;
  agentId?: string | null;
  inputFiles?: string[];
  metadata?: Record<string, unknown> | null;
  outputFile?: string | null;
  errorFile?: string | null;
  outputs?: unknown | null;
  createdAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  totalRequests?: number;
  completedRequests?: number;
  succeededRequests?: number;
  failedRequests?: number;
}

export interface MistralFilesResource<TParams, TFile, TOptions> {
  upload(params: TParams, options?: TOptions): Promise<TFile>;
}

export interface MistralBatchJobsResource<TParams, TBatch, TOptions> {
  create(params: TParams, options?: TOptions): Promise<TBatch>;
}

export type MistralBatchCompletionInput =
  | {
      requests: ReadonlyArray<MistralBatchRequestLike>;
      inputFileContents?: never;
    }
  | {
      inputFileContents: ReadonlyArray<{
        fileId: string;
        content: MistralBatchInputFileContent;
      }>;
      requests?: never;
    };

/** Opaque context that keeps collect-only retries on the same trace. */
export interface MistralBatchCollectionContext {
  readonly version: 1;
  readonly value: string;
}

export type CompleteMistralBatchTraceArgs<TBatch extends MistralBatchLike> = {
  batch: TBatch;
  outputFileContent?: MistralBatchJSONLSource;
  errorFileContent?: MistralBatchJSONLSource;
  /** Required when retrying a collect-only completion. */
  collectionContext?: MistralBatchCollectionContext;
  onTraceError?: (error: Error) => void | Promise<void>;
} & MistralBatchCompletionInput;

export interface PrepareMistralBatchTraceArgs {
  input: MistralBatchInput;
  params: MistralBatchCreateParams;
  onTraceError?: (error: Error) => void | Promise<void>;
}

export interface CompleteMistralBatchTraceImplArgs<
  TBatch extends MistralBatchLike,
> {
  batch: TBatch;
  input: MistralBatchInput;
  outputContent?: MistralBatchJSONLSource;
  errorContent?: MistralBatchJSONLSource;
  collectionContext?: MistralBatchCollectionContext;
  onTraceError?: (error: Error) => void | Promise<void>;
}
