// Narrow structural types for @deepgram/sdk 3.13, 4.x and 5.x.
export interface DeepgramRequest {
  text?: string;
  url?: string;
  body?: { text?: string; url?: string };
  callback?: string;
  model?: string;
  language?: string;
  encoding?: string;
  container?: string;
  sample_rate?: number;
  bit_rate?: number;
  speed?: number;
  sentiment?: boolean;
  topics?: boolean;
  intents?: boolean;
  summarize?: boolean | string;
  diarize?: boolean;
  smart_format?: boolean;
  punctuate?: boolean;
}
export interface DeepgramRequestOptions {
  queryParams?: { callback?: unknown };
}
export type DeepgramFile =
  | Blob
  | ArrayBuffer
  | Uint8Array
  | AsyncIterable<Uint8Array>
  | ReadableStream<Uint8Array>;
export interface DeepgramUsage {
  model_uuid?: string;
  input_tokens?: number;
  output_tokens?: number;
}
export interface DeepgramMetadata {
  request_id?: string;
  duration?: number;
  channels?: number;
  model_info?: Record<string, { name?: string }>;
  summary_info?: DeepgramUsage;
  sentiment_info?: DeepgramUsage;
  topics_info?: DeepgramUsage;
  intents_info?: DeepgramUsage;
}
export interface DeepgramResponse {
  metadata?: DeepgramMetadata;
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
        words?: unknown[];
      }>;
    }>;
    summary?: { text?: string };
    sentiments?: unknown;
    topics?: unknown;
    intents?: unknown;
    utterances?: unknown[];
  };
}
export interface DeepgramLegacyResponse {
  result: DeepgramResponse | null;
  error: Error | null;
}
export interface DeepgramAudio {
  stream(): ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  bytes?(): Promise<Uint8Array>;
}
export interface DeepgramLegacyAudio {
  getStream(): Promise<ReadableStream<Uint8Array> | null>;
  getHeaders(): Promise<Headers>;
}
export type DeepgramLegacyArgs = [
  source: DeepgramRequest,
  options?: DeepgramRequest,
  endpoint?: string,
];
export type DeepgramFileArgs = [
  file: DeepgramFile,
  request: DeepgramRequest,
  options?: DeepgramRequestOptions,
];
export type DeepgramArgs = [
  request: DeepgramRequest,
  options?: DeepgramRequestOptions,
];
export interface DeepgramClient {
  listen: {
    prerecorded?: {
      transcribeFile(
        file: DeepgramFile,
        options?: DeepgramRequest,
        endpoint?: string,
      ): PromiseLike<DeepgramLegacyResponse>;
      transcribeUrl(
        ...args: DeepgramLegacyArgs
      ): PromiseLike<DeepgramLegacyResponse>;
    };
    v1?: {
      media: {
        transcribeFile(
          ...args: DeepgramFileArgs
        ): PromiseLike<DeepgramResponse>;
        transcribeUrl(...args: DeepgramArgs): PromiseLike<DeepgramResponse>;
      };
    };
  };
  speak: {
    request?(...args: DeepgramLegacyArgs): PromiseLike<DeepgramLegacyAudio>;
    v1?: {
      audio: { generate(...args: DeepgramArgs): PromiseLike<DeepgramAudio> };
    };
    v2?: {
      audio: { generate(...args: DeepgramArgs): PromiseLike<DeepgramAudio> };
    };
  };
  read: {
    analyzeText?(
      ...args: DeepgramLegacyArgs
    ): PromiseLike<DeepgramLegacyResponse>;
    analyzeUrl?(
      ...args: DeepgramLegacyArgs
    ): PromiseLike<DeepgramLegacyResponse>;
    v1?: {
      text: { analyze(...args: DeepgramArgs): PromiseLike<DeepgramResponse> };
    };
  };
}
