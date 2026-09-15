/** Minimal structural types consumed from @google/generative-ai 0.24.x. */
export interface GenerativeAIPart {
  text?: string;
  inlineData?: { data: string; mimeType: string };
  fileData?: { fileUri: string; mimeType: string };
  functionCall?: { name: string; args: object };
  functionResponse?: { name: string; response: object };
}

export interface GenerativeAIContent {
  role?: string;
  parts: GenerativeAIPart[];
}

export type GenerativeAIMessage = string | (string | GenerativeAIPart)[];

export interface GenerativeAIConfig {
  generationConfig?: Record<string, unknown>;
  systemInstruction?: string | GenerativeAIPart | GenerativeAIContent;
  tools?: unknown[];
  toolConfig?: unknown;
  safetySettings?: unknown[];
  cachedContent?: string | { name?: string };
}

export interface GenerativeAIRequest extends GenerativeAIConfig {
  contents: GenerativeAIContent[];
}

export interface GenerativeAIEmbedRequest {
  content: GenerativeAIContent;
  outputDimensionality?: number;
}

export interface GenerativeAIResponse {
  candidates?: {
    index?: number;
    content?: GenerativeAIContent;
    finishReason?: string;
    safetyRatings?: unknown[];
    groundingMetadata?: unknown;
  }[];
  promptFeedback?: unknown;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

export interface GenerativeAIResult {
  response: GenerativeAIResponse;
}

export interface GenerativeAIStreamResult {
  stream: AsyncIterable<GenerativeAIResponse>;
  response: Promise<GenerativeAIResponse>;
}

export interface GenerativeAIEmbedResult {
  embedding?: { values: number[] };
  embeddings?: { values: number[] }[];
  usageMetadata?: {
    promptTokenCount?: number;
    promptTokenDetails?: { modality?: string; tokenCount?: number }[];
  };
}

export interface GenerativeAIChat {
  model: string;
  params?: GenerativeAIConfig;
  _history: GenerativeAIContent[];
  _sendPromise: Promise<void>;
  sendMessage(
    request: GenerativeAIMessage,
    options?: unknown,
  ): Promise<GenerativeAIResult>;
  sendMessageStream(
    request: GenerativeAIMessage,
    options?: unknown,
  ): Promise<GenerativeAIStreamResult>;
}

export interface GenerativeAIModel extends GenerativeAIConfig {
  model: string;
  generateContent(
    request: GenerativeAIMessage | GenerativeAIRequest,
    options?: unknown,
  ): Promise<GenerativeAIResult>;
  generateContentStream(
    request: GenerativeAIMessage | GenerativeAIRequest,
    options?: unknown,
  ): Promise<GenerativeAIStreamResult>;
  embedContent(
    request: GenerativeAIMessage | GenerativeAIEmbedRequest,
    options?: unknown,
  ): Promise<GenerativeAIEmbedResult>;
  batchEmbedContents(
    request: { requests: GenerativeAIEmbedRequest[] },
    options?: unknown,
  ): Promise<GenerativeAIEmbedResult>;
  startChat(...args: unknown[]): GenerativeAIChat;
}

export interface GenerativeAIClient {
  getGenerativeModel(...args: unknown[]): GenerativeAIModel;
  getGenerativeModelFromCachedContent(...args: unknown[]): GenerativeAIModel;
}
