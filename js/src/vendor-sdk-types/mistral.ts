export type MistralToolCallDelta = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  [key: string]: unknown;
};

export type MistralTextContentPart = {
  type: "text";
  text?: string;
  [key: string]: unknown;
};

export type MistralThinkingContentPart = {
  type: "thinking";
  thinking?: MistralTextContentPart[] | null;
  [key: string]: unknown;
};

export type MistralContentPart =
  | MistralTextContentPart
  | MistralThinkingContentPart;

export type MistralChatMessageDelta = {
  role?: string;
  content?: string | MistralContentPart[] | null;
  toolCalls?: MistralToolCallDelta[] | null;
  tool_calls?: MistralToolCallDelta[] | null;
  [key: string]: unknown;
};

export type MistralChatCompletionChoice = {
  index?: number;
  message?: {
    role?: string;
    content?: string | MistralContentPart[] | null;
    toolCalls?: unknown;
    tool_calls?: unknown;
  };
  finishReason?: string | null;
  finish_reason?: string | null;
  [key: string]: unknown;
};

export type MistralChatCompletionChunkChoice = {
  index?: number;
  delta?: MistralChatMessageDelta;
  finishReason?: string | null;
  finish_reason?: string | null;
  [key: string]: unknown;
};

export type MistralChatCompletionChunk = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  usage?: unknown;
  choices?: MistralChatCompletionChunkChoice[];
  [key: string]: unknown;
};

export type MistralChatCompletionEvent = {
  data?: MistralChatCompletionChunk;
  [key: string]: unknown;
};

export type MistralChatCompletionResponse = {
  id?: string;
  object?: string;
  model?: string;
  created?: number;
  usage?: unknown;
  choices?: MistralChatCompletionChoice[];
  [key: string]: unknown;
};

export type MistralEmbeddingCreateParams = {
  inputs?: unknown;
  [key: string]: unknown;
};

export type MistralFimCreateParams = {
  prompt?: unknown;
  suffix?: unknown;
  stream?: boolean;
  [key: string]: unknown;
};

export type MistralAgentsCreateParams = {
  messages?: unknown;
  agentId?: string;
  agent_id?: string;
  stream?: boolean;
  [key: string]: unknown;
};

export type MistralClassificationCreateParams = {
  input?: unknown;
  inputs?: unknown;
  [key: string]: unknown;
};

export type MistralChatClassificationCreateParams = {
  input?: unknown;
  inputs?: unknown;
  [key: string]: unknown;
};

export type MistralEmbeddingResponse = {
  id?: string;
  object?: string;
  model?: string;
  usage?: unknown;
  data?: Array<{
    embedding?: number[] | string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type MistralChatCreateParams = {
  messages?: unknown;
  stream?: boolean;
  [key: string]: unknown;
};

export type MistralChatStreamingResult =
  AsyncIterable<MistralChatCompletionEvent>;
export type MistralFimStreamingResult =
  AsyncIterable<MistralChatCompletionEvent>;
export type MistralAgentsStreamingResult =
  AsyncIterable<MistralChatCompletionEvent>;

export type MistralFimCompletionResponse = MistralChatCompletionResponse;
export type MistralAgentsCompletionResponse = MistralChatCompletionResponse;
export type MistralFimCompletionEvent = MistralChatCompletionEvent;
export type MistralAgentsCompletionEvent = MistralChatCompletionEvent;

export type MistralClassificationResponse = {
  id?: string;
  model?: string;
  results?: unknown;
  usage?: unknown;
  [key: string]: unknown;
};

export type MistralModerationResponse = MistralClassificationResponse;

export type MistralChatResult =
  | MistralChatCompletionResponse
  | MistralChatStreamingResult;
export type MistralFimResult =
  | MistralFimCompletionResponse
  | MistralFimStreamingResult;
export type MistralAgentsResult =
  | MistralAgentsCompletionResponse
  | MistralAgentsStreamingResult;

export type MistralChat = {
  complete: (
    request: MistralChatCreateParams,
    options?: unknown,
  ) => Promise<MistralChatCompletionResponse>;
  stream: (
    request: MistralChatCreateParams,
    options?: unknown,
  ) => Promise<MistralChatStreamingResult>;
};

export type MistralEmbeddings = {
  create: (
    request: MistralEmbeddingCreateParams,
    options?: unknown,
  ) => Promise<MistralEmbeddingResponse>;
};

export type MistralFim = {
  complete: (
    request: MistralFimCreateParams,
    options?: unknown,
  ) => Promise<MistralFimCompletionResponse>;
  stream: (
    request: MistralFimCreateParams,
    options?: unknown,
  ) => Promise<MistralFimStreamingResult>;
};

export type MistralAgents = {
  complete: (
    request: MistralAgentsCreateParams,
    options?: unknown,
  ) => Promise<MistralAgentsCompletionResponse>;
  stream: (
    request: MistralAgentsCreateParams,
    options?: unknown,
  ) => Promise<MistralAgentsStreamingResult>;
};

export type MistralClassifiers = {
  moderate: (
    request: MistralClassificationCreateParams,
    options?: unknown,
  ) => Promise<MistralModerationResponse>;
  moderateChat: (
    request: MistralChatClassificationCreateParams,
    options?: unknown,
  ) => Promise<MistralModerationResponse>;
  classify?: (
    request: MistralClassificationCreateParams,
    options?: unknown,
  ) => Promise<MistralClassificationResponse>;
  classifyChat?: (
    request: MistralChatClassificationCreateParams,
    options?: unknown,
  ) => Promise<MistralClassificationResponse>;
};

export type MistralClient = {
  audio?: MistralAudio;
  ocr?: MistralOCR;
  chat?: MistralChat;
  fim?: MistralFim;
  agents?: MistralAgents;
  embeddings?: MistralEmbeddings;
  classifiers?: MistralClassifiers;
  [key: string]: unknown;
};

// Narrow surfaces shared by the manual wrapper and invocation hooks.
export type MistralTranscriptionParams = {
  model: string;
  file?:
    | Blob
    | {
        fileName: string;
        content: Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
      };
  fileUrl?: string | null;
  fileId?: string | null;
  language?: string | null;
  temperature?: number | null;
  diarize?: boolean;
  contextBias?: string[];
  timestampGranularities?: string[];
};
export type MistralTranscriptionResponse = {
  model?: string;
  text?: string;
  language?: string | null;
  segments?: Array<{
    text: string;
    start: number | null;
    end: number | null;
    speakerId?: string | null;
  }>;
  usage?: Record<string, unknown>;
};
export type MistralTranscriptionEvent = {
  data: MistralTranscriptionResponse & {
    type: string;
    start?: number | null;
    end?: number | null;
    speakerId?: string | null;
  };
};
export type MistralSpeechParams = {
  model?: string | null;
  input: string;
  voiceId?: string | null;
  refAudio?: string | null;
  stream?: boolean;
  responseFormat?: string;
};
export type MistralSpeechResponse = { audioData: string };
export type MistralSpeechEvent = {
  data: { type: string; audioData?: string; usage?: Record<string, unknown> };
};
export type MistralSpeechResult =
  | MistralSpeechResponse
  | AsyncIterable<MistralSpeechEvent>;
export type MistralAudio = {
  transcriptions?: {
    complete(
      request: MistralTranscriptionParams,
      options?: unknown,
    ): Promise<MistralTranscriptionResponse>;
    stream(
      request: MistralTranscriptionParams,
      options?: unknown,
    ): Promise<AsyncIterable<MistralTranscriptionEvent>>;
  };
  speech?: {
    complete(
      request: MistralSpeechParams,
      options?: unknown,
    ): Promise<MistralSpeechResult>;
  };
};
export type MistralOCRParams = {
  model: string | null;
  document: {
    type?: string;
    documentUrl?: string;
    documentName?: string | null;
    imageUrl?: string;
    fileId?: string;
  };
  pages?: number[] | string | null;
  includeImageBase64?: boolean | null;
  imageLimit?: number | null;
  tableFormat?: string | null;
};
export type MistralOCRResponse = {
  model?: string;
  documentAnnotation?: string | null;
  pages: Array<{
    index: number;
    markdown: string;
    header?: string | null;
    footer?: string | null;
    dimensions?: { dpi: number; height: number; width: number } | null;
    tables?: Array<{ id: string; content: string; format: string }>;
    hyperlinks?: string[];
    images: Array<{
      id: string;
      topLeftX?: number | null;
      topLeftY?: number | null;
      bottomRightX?: number | null;
      bottomRightY?: number | null;
      imageBase64?: string | null;
      imageAnnotation?: string | null;
    }>;
  }>;
  usageInfo?: { pagesProcessed?: number; docSizeBytes?: number | null };
};
export type MistralOCR = {
  process(
    request: MistralOCRParams,
    options?: unknown,
  ): Promise<MistralOCRResponse>;
};
