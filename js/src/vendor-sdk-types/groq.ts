import type {
  OpenAIAPIPromise,
  OpenAIChatChoice,
  OpenAIChatCompletionChunk,
  OpenAIChatCreateParams,
  OpenAIChatStream,
  OpenAIEmbeddingCreateParams,
  OpenAIUsage,
} from "./openai-common";

export interface GroqUsage extends OpenAIUsage {
  queue_time?: number;
}

export interface GroqChatCompletion {
  choices: OpenAIChatChoice[];
  usage?: GroqUsage;
  x_groq?: {
    id?: string;
    seed?: number | null;
    usage?: {
      dram_cached_tokens?: number;
      sram_cached_tokens?: number;
      [key: string]: number | undefined;
    } | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export type GroqChatCompletionChunk = OpenAIChatCompletionChunk & {
  usage?: GroqUsage;
};
export type GroqChatCreateParams = OpenAIChatCreateParams;
export type GroqChatStream = OpenAIChatStream;

export interface GroqEmbeddingCreateParams extends OpenAIEmbeddingCreateParams {
  model?: string;
}

export interface GroqEmbeddingResponse {
  data?: Array<{
    embedding?: number[] | string;
    [key: string]: unknown;
  }>;
  usage?: GroqUsage;
  [key: string]: unknown;
}

export interface GroqAudioTranscriptionCreateParams {
  file?: unknown;
  language?: string | null;
  model: string;
  prompt?: string;
  response_format?: string;
  temperature?: number;
  timestamp_granularities?: Array<"word" | "segment">;
  url?: string;
  [key: string]: unknown;
}

export interface GroqAudioTranslationCreateParams {
  file?: unknown;
  model: string;
  prompt?: string;
  response_format?: string;
  temperature?: number;
  url?: string;
  [key: string]: unknown;
}

export interface GroqAudioSpeechCreateParams {
  input: string;
  model: string;
  response_format?: string;
  sample_rate?: number;
  speed?: number;
  voice: string;
  [key: string]: unknown;
}

export interface GroqAudioTextResult {
  duration?: number;
  language?: string;
  segments?: unknown[];
  text?: string;
  words?: unknown[];
  [key: string]: unknown;
}

export interface GroqChatCompletions {
  create: (
    params: GroqChatCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<GroqChatCompletion | GroqChatStream>;
}

export interface GroqChat {
  completions: GroqChatCompletions;
}

export interface GroqEmbeddings {
  create: (
    params: GroqEmbeddingCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<GroqEmbeddingResponse>;
}

export interface GroqAudioSpeech {
  create: (
    params: GroqAudioSpeechCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<Response>;
}

export interface GroqAudioTranscriptions {
  create: (
    params: GroqAudioTranscriptionCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<GroqAudioTextResult | string>;
}

export interface GroqAudioTranslations {
  create: (
    params: GroqAudioTranslationCreateParams,
    options?: unknown,
  ) => OpenAIAPIPromise<GroqAudioTextResult | string>;
}

export interface GroqAudio {
  speech?: GroqAudioSpeech;
  transcriptions?: GroqAudioTranscriptions;
  translations?: GroqAudioTranslations;
}

export interface GroqClient {
  audio?: GroqAudio;
  chat?: GroqChat;
  embeddings?: GroqEmbeddings;
  [key: string]: unknown;
}
