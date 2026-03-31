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

export interface AnthropicCitation {
  type: string;
  [key: string]: unknown;
}

export type AnthropicOutputContentBlock =
  | { type: "text"; text: string; citations?: AnthropicCitation[] }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "thinking"; thinking: string }
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
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "citations_delta"; citation: AnthropicCitation }
        | { type: "signature_delta"; signature: string }
        | { type: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string; stop_sequence?: string | null };
      usage?: AnthropicUsage;
    }
  | { type: "message_stop" };
