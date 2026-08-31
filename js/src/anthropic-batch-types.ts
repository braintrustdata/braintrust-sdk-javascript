import type { BraintrustState } from "./logger";

interface AnthropicBatchMessageCreateParams {
  max_tokens?: number;
  messages: unknown[];
  model: string;
  system?: unknown;
  stream?: false;
}

export interface AnthropicBatchRequest {
  custom_id: string;
  params: AnthropicBatchMessageCreateParams;
}

export interface AnthropicBatchCreateParams {
  requests: AnthropicBatchRequest[];
}

export interface AnthropicBatchRequestCounts {
  canceled: number;
  errored: number;
  expired: number;
  processing: number;
  succeeded: number;
}

export interface AnthropicBatchLike {
  id: string;
  created_at: string;
  ended_at?: string | null;
  processing_status: string;
  request_counts: AnthropicBatchRequestCounts;
}

export type AnthropicBatchResult =
  | { message: unknown; type: "succeeded" }
  | { error: unknown; type: "errored" }
  | { type: "canceled" }
  | { type: "expired" };

export interface AnthropicBatchResultRecord {
  custom_id: string;
  result: AnthropicBatchResult;
}

type AnthropicBatchResults =
  | Iterable<AnthropicBatchResultRecord>
  | AsyncIterable<AnthropicBatchResultRecord>;

export type AnthropicBatchResultsSource =
  | AnthropicBatchResults
  | PromiseLike<AnthropicBatchResults>;

export type AnthropicEnhancedResponse<T> = {
  data: T;
  request_id?: string | null;
  response: Response;
};

export interface AnthropicAPIPromise<T> extends Promise<T> {
  asResponse(): Promise<Response>;
  withResponse(): Promise<AnthropicEnhancedResponse<T>>;
}

export interface AnthropicBatchesResource<TParams, TBatch, TOptions> {
  create(params: TParams, options?: TOptions): AnthropicAPIPromise<TBatch>;
}

export interface AnthropicBatchesCreateTraceArgs<
  TParams extends AnthropicBatchCreateParams = AnthropicBatchCreateParams,
> {
  params: TParams;
  parent: { export(): Promise<string> } | { toStr(): string };
  state?: BraintrustState;
}

export interface AnthropicBatchesCreateTracedOptions {
  state?: BraintrustState;
}

export interface CompleteAnthropicBatchTraceArgs<
  TBatch extends AnthropicBatchLike = AnthropicBatchLike,
  TParams extends AnthropicBatchCreateParams = AnthropicBatchCreateParams,
> {
  batch: TBatch;
  params: TParams;
  results: AnthropicBatchResultsSource;
  state?: BraintrustState;
}
