/**
 * A vendored type for the @google/genai SDK which our wrapper consumes.
 *
 * Should never be exposed to users of the SDK!
 *
 * Note: If there ever is a new major of the @google/genai SDK, do: `export type GoogleGenAIClient = GoogleGenAIV1Client | GoogleGenAIV2Client`
 */

// Module

export interface GoogleGenAIConstructor {
  new (...args: unknown[]): GoogleGenAIClient;
}

// Client

export interface GoogleGenAIClient {
  models: GoogleGenAIModels;
}

export interface GoogleGenAIModels {
  generateContent: (
    params: GoogleGenAIGenerateContentParams,
  ) => Promise<GoogleGenAIGenerateContentResponse>;
  generateContentStream: (
    params: GoogleGenAIGenerateContentParams,
  ) => Promise<AsyncGenerator<GoogleGenAIGenerateContentResponse>>;
  embedContent: (
    params: GoogleGenAIEmbedContentParams,
  ) => Promise<GoogleGenAIEmbedContentResponse>;
}

// Requests

export interface GoogleGenAIGenerateContentParams {
  model: string;
  contents: string | GoogleGenAIContent | GoogleGenAIContent[];
  config?: {
    tools?: {
      functionDeclarations?: Record<string, unknown>[];
      [key: string]: unknown;
    }[];
    toJSON?: () => Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GoogleGenAIEmbedContentParams {
  model: string;
  contents: string | GoogleGenAIContent | GoogleGenAIContent[];
  config?: {
    outputDimensionality?: number;
    taskType?: string;
    toJSON?: () => Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GoogleGenAIContent {
  role?: string;
  parts: GoogleGenAIPart[];
}

export interface GoogleGenAIPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    data: Uint8Array | string;
    mimeType: string;
  };
  functionCall?: Record<string, unknown>;
  codeExecutionResult?: Record<string, unknown>;
  executableCode?: Record<string, unknown>;
}

// Responses

export interface GoogleGenAIGenerateContentResponse {
  candidates?: {
    content?: {
      parts: GoogleGenAIPart[];
      role?: string;
    };
    finishReason?: string;
    groundingMetadata?: GoogleGenAIGroundingMetadata;
    safetyRatings?: Record<string, unknown>[];
  }[];
  groundingMetadata?: GoogleGenAIGroundingMetadata;
  usageMetadata?: GoogleGenAIUsageMetadata;
  text?: string;
  [key: string]: unknown;
}

export interface GoogleGenAIEmbedding {
  values?: number[];
  [key: string]: unknown;
}

export interface GoogleGenAIEmbedContentResponse {
  embedding?: GoogleGenAIEmbedding;
  embeddings?: GoogleGenAIEmbedding[];
  usageMetadata?: GoogleGenAIUsageMetadata;
  [key: string]: unknown;
}

export interface GoogleGenAIGroundingMetadata {
  groundingChunks?: Array<{
    web?: {
      title?: string;
      uri?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  groundingSupports?: Record<string, unknown>[];
  searchEntryPoint?: Record<string, unknown>;
  webSearchQueries?: string[];
  [key: string]: unknown;
}

export interface GoogleGenAIUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}
