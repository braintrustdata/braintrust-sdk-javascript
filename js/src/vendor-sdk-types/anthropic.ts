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
  messages: AnthropicBetaMessages;
  sessions?: AnthropicBetaSessions;
}

export interface AnthropicMessages {
  create: (
    params: AnthropicCreateParams,
  ) => AnthropicAPIPromise<AnthropicMessage | AnthropicMessageStream>;
}

export interface AnthropicBetaMessages extends AnthropicMessages {
  toolRunner: (
    params: AnthropicToolRunnerParams,
  ) => AnthropicToolRunner<unknown>;
}

export interface AnthropicBetaSessions {
  events: AnthropicBetaSessionEvents;
  threads?: AnthropicBetaSessionThreads;
}

export interface AnthropicBetaSessionEvents {
  stream: (
    sessionId: string,
    params?: AnthropicSessionEventStreamParams,
  ) => AnthropicAPIPromise<AnthropicSessionEventStream>;
}

export interface AnthropicBetaSessionThreads {
  events: AnthropicBetaSessionThreadEvents;
}

export interface AnthropicBetaSessionThreadEvents {
  stream: (
    threadId: string,
    params: AnthropicSessionThreadEventStreamParams,
  ) => AnthropicAPIPromise<AnthropicSessionEventStream>;
}

export interface AnthropicAPIPromise<T> extends Promise<T> {
  withResponse(): Promise<AnthropicWithResponse<T>>;
}

interface AnthropicWithResponse<T> {
  data: T;
}

export interface AnthropicMessageStream extends AsyncIterable<AnthropicStreamEvent> {
  finalMessage?: () => Promise<AnthropicMessage>;
  abort?: () => void;
}

export interface AnthropicSessionEventStream extends AsyncIterable<AnthropicSessionEvent> {
  abort?: () => void;
}

export interface AnthropicToolRunner<TYield>
  extends AsyncIterable<TYield>, PromiseLike<AnthropicMessage> {
  done?: () => Promise<AnthropicMessage>;
  runUntilDone?: () => Promise<AnthropicMessage>;
}

// Requests

export interface AnthropicCreateParams {
  messages: AnthropicInputMessage[];
  system?: string | { type: "text"; text: string }[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface AnthropicToolRunnerParams extends AnthropicCreateParams {
  tools: AnthropicToolRunnerTool[];
  max_iterations?: number;
  compactionControl?: unknown;
}

export interface AnthropicToolRunnerTool {
  name?: string;
  run?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export interface AnthropicSessionEventStreamParams {
  event_deltas?: string[];
  [key: string]: unknown;
}

export interface AnthropicSessionThreadEventStreamParams extends AnthropicSessionEventStreamParams {
  session_id: string;
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
  model?: string;
  usage?: AnthropicUsage;
  stop_reason?: string;
  stop_sequence?: string | null;
}

export interface AnthropicCitation {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicServerToolUseContentBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicWebSearchResultContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicWebSearchToolResultContentBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: AnthropicWebSearchResultContentBlock[];
}

export interface AnthropicThinkingContentBlock {
  type: "thinking";
  thinking: string;
}

export type AnthropicOutputContentBlock =
  | { type: "text"; text: string; citations?: AnthropicCitation[] }
  | AnthropicToolUseContentBlock
  | AnthropicServerToolUseContentBlock
  | AnthropicWebSearchToolResultContentBlock
  | AnthropicThinkingContentBlock
  | { type: string };

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: AnthropicCacheCreationUsage | null;
  server_tool_use?: AnthropicServerToolUseUsage;
  [key: string]: unknown;
}

/**
 * Per-TTL breakdown of cache-write tokens. Only recent Anthropic SDK versions
 * report this; older ones expose just `cache_creation_input_tokens`.
 */
export interface AnthropicCacheCreationUsage {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  [key: string]: unknown;
}

export interface AnthropicServerToolUseUsage {
  web_search_requests?: number;
  [key: string]: unknown;
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

export interface AnthropicSessionContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AnthropicSessionEventBase {
  id?: string;
  processed_at?: string | null;
  type: string;
  [key: string]: unknown;
}

export interface AnthropicSessionMessageEvent extends AnthropicSessionEventBase {
  content: AnthropicSessionContentBlock[];
  type: "agent.message" | "system.message" | "user.message";
}

export interface AnthropicSessionModelRequestStartEvent extends AnthropicSessionEventBase {
  id: string;
  type: "span.model_request_start";
}

export interface AnthropicSessionModelUsage {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicSessionModelRequestEndEvent extends AnthropicSessionEventBase {
  is_error?: boolean | null;
  model_request_start_id: string;
  model_usage: AnthropicSessionModelUsage;
  type: "span.model_request_end";
}

export interface AnthropicSessionToolUseEvent extends AnthropicSessionEventBase {
  evaluated_permission?: "allow" | "ask" | "deny" | null;
  id: string;
  input: Record<string, unknown>;
  name: string;
  type: "agent.custom_tool_use" | "agent.mcp_tool_use" | "agent.tool_use";
}

export interface AnthropicSessionToolResultEvent extends AnthropicSessionEventBase {
  content?: AnthropicSessionContentBlock[];
  custom_tool_use_id?: string;
  is_error?: boolean | null;
  mcp_tool_use_id?: string;
  tool_use_id?: string;
  type:
    | "agent.mcp_tool_result"
    | "agent.tool_result"
    | "user.custom_tool_result"
    | "user.tool_result";
}

export interface AnthropicSessionToolConfirmationEvent extends AnthropicSessionEventBase {
  result: "allow" | "deny";
  tool_use_id: string;
  type: "user.tool_confirmation";
}

export interface AnthropicSessionEventDelta extends AnthropicSessionEventBase {
  delta?: {
    content?: AnthropicSessionContentBlock;
    index?: number;
    type?: string;
  };
  event_id?: string;
  type: "event_delta";
}

export interface AnthropicSessionStatusEvent extends AnthropicSessionEventBase {
  error?: unknown;
  stop_reason?: {
    type?: "end_turn" | "requires_action" | "retries_exhausted" | string;
  };
  type:
    | "session.deleted"
    | "session.error"
    | "session.status_idle"
    | "session.status_running"
    | "session.status_terminated"
    | "session.thread_status_idle"
    | "session.thread_status_running"
    | "session.thread_status_terminated";
}

export type AnthropicSessionEvent =
  | AnthropicSessionEventDelta
  | AnthropicSessionMessageEvent
  | AnthropicSessionModelRequestEndEvent
  | AnthropicSessionModelRequestStartEvent
  | AnthropicSessionStatusEvent
  | AnthropicSessionToolConfirmationEvent
  | AnthropicSessionToolResultEvent
  | AnthropicSessionToolUseEvent
  | AnthropicSessionEventBase;
