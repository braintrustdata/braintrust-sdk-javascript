/**
 * A vendered type for the anthropic SDK which our wrapper consumes.
 *
 * Should never be exposed to users of the SDK!
 *
 * Note: If there ever is a new major of the anthropic SDK, do: `export type AnthropicClient = AthropicV4Client | AnthropicV5Client`
 */

// Client

export interface AnthropicClient {
  messages: AnthropicMessages;
  beta?: AnthropicBeta;
}

export interface AnthropicBeta {
  messages: AnthropicMessages;
}

export interface AnthropicMessages {
  create: (
    params: AnthropicCreateParams,
  ) => AnthropicAPIPromise<
    AnthropicMessage | AsyncIterable<AnthropicStreamEvent>
  >;
  batches: AnthropicBatches;
}

// Batches API

export interface AnthropicBatches {
  create: (
    params: AnthropicBatchCreateParams,
  ) => AnthropicAPIPromise<AnthropicMessageBatch>;
  retrieve: (batchId: string) => AnthropicAPIPromise<AnthropicMessageBatch>;
  list: (params?: AnthropicBatchListParams) => AnthropicAPIPromise<unknown>;
  cancel: (batchId: string) => AnthropicAPIPromise<AnthropicMessageBatch>;
  delete: (batchId: string) => AnthropicAPIPromise<unknown>;
}

export interface AnthropicBatchCreateParams {
  requests: AnthropicBatchRequest[];
  [key: string]: unknown;
}

export interface AnthropicBatchRequest {
  custom_id: string;
  params: AnthropicCreateParams;
}

export interface AnthropicBatchListParams {
  [key: string]: unknown;
}

export interface AnthropicMessageBatch {
  id: string;
  type: "message_batch";
  processing_status: "in_progress" | "canceling" | "ended" | string;
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  created_at: string;
  expires_at: string;
  archived_at?: string | null;
  cancel_initiated_at?: string | null;
  results_url?: string | null;
}

export interface AnthropicAPIPromise<T> extends Promise<T> {
  withResponse(): Promise<AnthropicWithResponse<T>>;
}

export interface AnthropicWithResponse<T> {
  data: T;
}

// Requests

export interface AnthropicCreateParams {
  messages: AnthropicInputMessage[];
  system?: string | { type: "text"; text: string }[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface AnthropicInputMessage {
  role: string;
  content:
    | string
    | (
        | { type: "text"; text: string }
        | {
            type: "image";
            source: AnthropicBase64Source | { type: "url"; url: string };
          }
        | {
            type: "document";
            source: AnthropicBase64Source | { type: "url"; url: string };
          }
        | {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          }
        | { type: string }
      )[];
}

export interface AnthropicBase64Source {
  type: "base64";
  media_type: string;
  data: string;
}

// Responses

export interface AnthropicMessage {
  role: string;
  content: AnthropicOutputContentBlock[];
  usage?: AnthropicUsage;
  stop_reason?: string;
  stop_sequence?: string | null;
}

export type AnthropicOutputContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: string };

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type AnthropicStreamEvent =
  | { type: "message_start"; message: AnthropicMessage }
  | {
      type: "content_block_start";
      index: number;
      content_block: AnthropicOutputContentBlock;
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string; stop_sequence?: string | null };
      usage?: AnthropicUsage;
    }
  | { type: "message_stop" };
