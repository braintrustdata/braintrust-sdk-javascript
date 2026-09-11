/** Minimal structural types for @elevenlabs/elevenlabs-js 2.x. */
export interface ElevenLabsSpeechRequest {
  text: string;
  modelId?: string;
  outputFormat?: string;
  languageCode?: string;
  voiceSettings?: { speed?: number };
}

export interface ElevenLabsTranscriptionRequest {
  modelId: string;
  file?: Blob | Uint8Array | ArrayBuffer | AsyncIterable<Uint8Array>;
  cloudStorageUrl?: string;
  languageCode?: string;
  timestampsGranularity?: string;
  webhook?: boolean;
}

export interface ElevenLabsTranscription {
  text?: string;
  languageCode?: string;
  words?: unknown[];
  transcripts?: ElevenLabsTranscription[];
}

export interface ElevenLabsTimestampAudio {
  audioBase64: string;
  alignment?: unknown;
  normalizedAlignment?: unknown;
}

export type ElevenLabsAudio =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;
export type ElevenLabsSpeechArgs = [
  voiceId: string,
  request: ElevenLabsSpeechRequest,
  options?: unknown,
];
export interface ElevenLabsClient {
  textToSpeech: {
    convert(...args: ElevenLabsSpeechArgs): PromiseLike<ElevenLabsAudio>;
    stream(...args: ElevenLabsSpeechArgs): PromiseLike<ElevenLabsAudio>;
    convertWithTimestamps(
      ...args: ElevenLabsSpeechArgs
    ): PromiseLike<ElevenLabsTimestampAudio>;
    streamWithTimestamps(
      ...args: ElevenLabsSpeechArgs
    ): PromiseLike<AsyncIterable<ElevenLabsTimestampAudio>>;
  };
  speechToText: {
    convert(
      request: ElevenLabsTranscriptionRequest,
      options?: unknown,
    ): PromiseLike<ElevenLabsTranscription>;
  };
}
