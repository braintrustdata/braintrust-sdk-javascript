type MistralBatchJSONLContent =
  | string
  | Iterable<unknown>
  | AsyncIterable<unknown>
  | ReadableStream<Uint8Array>
  | Response;

export type MistralBatchJSONLSource =
  | MistralBatchJSONLContent
  | PromiseLike<MistralBatchJSONLContent>;

/**
 * Repeatable input content. Use a factory for one-shot sources such as a
 * Response, ReadableStream, generator, or async iterable because start and
 * completion may read the input in different processes or at different times.
 */
export type MistralBatchInputFileContent =
  | string
  | ReadonlyArray<unknown>
  | (() => MistralBatchJSONLSource);

export interface MistralBatchFileLike {
  id: string;
  [key: string]: unknown;
}

export interface MistralBatchRequestLike {
  customId: string;
  body: Record<string, unknown>;
  [key: string]: unknown;
}

export type MistralBatchInput =
  | {
      files: ReadonlyArray<{
        file: MistralBatchFileLike;
        content: MistralBatchInputFileContent;
      }>;
    }
  | { requests: ReadonlyArray<MistralBatchRequestLike> };

interface MistralBatchCreateInputParamsBase {
  endpoint: "/v1/chat/completions";
  metadata?: Record<string, string> | null;
  timeoutHours?: number;
  [key: string]: unknown;
}

export type MistralBatchCreateInputParams = MistralBatchCreateInputParamsBase &
  ({ model: string; agentId?: never } | { agentId: string; model?: never });

export type MistralBatchCreateParams = MistralBatchCreateInputParams & {
  inputFiles?: string[];
  requests?: MistralBatchRequestLike[];
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

export interface StartMistralBatchTraceArgs {
  input: MistralBatchInput;
  params: MistralBatchCreateInputParams;
  onTraceError?: (error: Error) => void | Promise<void>;
}

/** Opaque context that keeps collect-only retries on the same trace. */
export interface MistralBatchCollectionContext {
  readonly version: 1;
  readonly value: string;
}

export interface MistralBatchTraceCollection<TBatch extends MistralBatchLike> {
  batch: TBatch;
  collectionContext?: MistralBatchCollectionContext;
}

export interface CompleteMistralBatchTraceArgs<
  TBatch extends MistralBatchLike,
> {
  batch: TBatch;
  input: MistralBatchInput;
  outputContent?: MistralBatchJSONLSource;
  errorContent?: MistralBatchJSONLSource;
  /** Required when retrying a collect-only completion. */
  collectionContext?: MistralBatchCollectionContext;
  onTraceError?: (error: Error) => void | Promise<void>;
}

export interface FailMistralBatchTraceArgs {
  params: MistralBatchCreateParams;
  input: MistralBatchInput;
  error: unknown;
  onTraceError?: (error: Error) => void | Promise<void>;
}
