/** Minimal OpenAI image/audio surfaces used by instrumentation. */
export interface OpenAIMediaParams {
  model?: string;
  prompt?: string;
  input?: string;
  image?: unknown;
  mask?: unknown;
  file?: unknown;
  stream?: boolean;
  response_format?: string;
  output_format?: string;
  [key: string]: unknown;
}

export interface OpenAIMediaResult {
  model?: string;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  output_format?: string;
  text?: string;
  language?: string;
  duration?: number;
  segments?: unknown[];
  words?: unknown[];
  usage?: unknown;
}

export interface OpenAIMediaEvent extends OpenAIMediaResult {
  type: string;
  b64_json?: string;
  audio?: string;
  delta?: string;
  segment?: unknown;
}

export type OpenAIMediaResponse =
  | OpenAIMediaResult
  | string
  | Response
  | AsyncIterable<OpenAIMediaEvent>;
export type OpenAIMediaMethod = (
  params: OpenAIMediaParams,
  options?: unknown,
) => PromiseLike<OpenAIMediaResponse>;
export interface OpenAIMediaClient {
  images?: {
    generate: OpenAIMediaMethod;
    edit: OpenAIMediaMethod;
    createVariation: OpenAIMediaMethod;
  };
  audio?: {
    speech: { create: OpenAIMediaMethod };
    transcriptions: { create: OpenAIMediaMethod };
    translations: { create: OpenAIMediaMethod };
  };
}
