import type { BraintrustState } from "./logger";

export type AnthropicBatchTraceContext = string;

export interface AnthropicBatchMessageCreateParams {
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

export type AnthropicBatchResults =
  | Iterable<AnthropicBatchResultRecord>
  | AsyncIterable<AnthropicBatchResultRecord>;

export type AnthropicBatchResultsSource =
  | AnthropicBatchResults
  | PromiseLike<AnthropicBatchResults>;

export interface StartAnthropicBatchTraceArgs<
  TParams extends AnthropicBatchCreateParams = AnthropicBatchCreateParams,
> {
  params: TParams;
  state?: BraintrustState;
}

export interface StartAnthropicBatchTraceResult<
  TParams extends AnthropicBatchCreateParams = AnthropicBatchCreateParams,
> {
  params: TParams;
  traceContext?: AnthropicBatchTraceContext;
}

export interface BindAnthropicBatchTraceArgs<
  TBatch extends AnthropicBatchLike = AnthropicBatchLike,
> {
  batch: TBatch;
  state?: BraintrustState;
  traceContext?: AnthropicBatchTraceContext;
}

export interface CompleteAnthropicBatchTraceArgs<
  TBatch extends AnthropicBatchLike = AnthropicBatchLike,
  TParams extends AnthropicBatchCreateParams = AnthropicBatchCreateParams,
> {
  batch: TBatch;
  params: TParams;
  results: AnthropicBatchResultsSource;
  state?: BraintrustState;
  traceContext?: AnthropicBatchTraceContext;
}

export interface FailAnthropicBatchTraceArgs<
  TParams extends AnthropicBatchCreateParams = AnthropicBatchCreateParams,
> {
  error: unknown;
  params: TParams;
  state?: BraintrustState;
  traceContext: AnthropicBatchTraceContext;
}
