// The public Workers AI binding surface used by this integration.
// https://developers.cloudflare.com/workers-ai/configuration/bindings/
export interface WorkersAIInput {
  state?: unknown;
  questions?: Record<string, Record<string, unknown>>;
  fields?: Record<string, Record<string, unknown>>;
  images?: WorkersAIMedia[];
  audio?: WorkersAIMedia[];
  videos?: WorkersAIMedia[];
  reference_date?: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export type WorkersAIMedia = string | { content_type: string; base64: string };

export interface WorkersAIResult {
  model?: string;
  answers?: Record<string, Record<string, unknown>>;
  truncated?: boolean;
  state_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    passes?: number;
  };
}

export interface WorkersAIOptions {
  returnRawResponse?: boolean;
  websocket?: boolean;
  queueRequest?: boolean;
  [key: string]: unknown;
}

export interface WorkersAI {
  run(
    model: string,
    inputs: WorkersAIInput,
    options?: WorkersAIOptions,
  ): PromiseLike<WorkersAIResult>;
}
