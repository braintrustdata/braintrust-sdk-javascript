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
  chats: GoogleGenAIChats;
  interactions?: GoogleGenAIInteractions;
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

export interface GoogleGenAIChats {
  modelsModule?: GoogleGenAIModels;
}

export interface GoogleGenAIInteractions {
  create: (
    params: GoogleGenAIInteractionCreateParams,
    options?: Record<string, unknown>,
  ) => Promise<
    GoogleGenAIInteraction | AsyncIterable<GoogleGenAIInteractionSSEEvent>
  >;
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

export interface GoogleGenAIInteractionCreateParams {
  input:
    | string
    | GoogleGenAIInteractionStep[]
    | GoogleGenAIInteractionContent[]
    | GoogleGenAIInteractionContent
    | Record<string, unknown>;
  model?: string;
  agent?: string;
  agent_config?: Record<string, unknown>;
  api_version?: string;
  background?: boolean;
  environment?: string | Record<string, unknown>;
  generation_config?: Record<string, unknown>;
  previous_interaction_id?: string;
  response_format?: unknown;
  response_mime_type?: string;
  response_modalities?: string[];
  service_tier?: string;
  store?: boolean;
  stream?: boolean;
  system_instruction?: string;
  tools?: Record<string, unknown>[];
  webhook_config?: Record<string, unknown>;
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

export interface GoogleGenAIInteractionContent {
  type?: string;
  text?: string;
  data?: string;
  mime_type?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface GoogleGenAIInteractionStep {
  type?: string;
  content?: GoogleGenAIInteractionContent | GoogleGenAIInteractionContent[];
  [key: string]: unknown;
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
  statistics?: {
    tokenCount?: number;
    truncated?: boolean;
  };
}

export interface GoogleGenAIEmbedContentMetadata {
  billableCharacterCount?: number;
}

export interface GoogleGenAIEmbedContentResponse {
  embedding?: GoogleGenAIEmbedding;
  embeddings?: GoogleGenAIEmbedding[];
  metadata?: GoogleGenAIEmbedContentMetadata;
  usageMetadata?: GoogleGenAIUsageMetadata;
  [key: string]: unknown;
}

export interface GoogleGenAIInteraction {
  id?: string;
  created?: string;
  status?: string;
  steps?: GoogleGenAIInteractionStep[];
  updated?: string;
  input?: GoogleGenAIInteractionCreateParams["input"];
  model?: string;
  agent?: string;
  usage?: GoogleGenAIInteractionUsage;
  output_text?: string;
  output_image?: GoogleGenAIInteractionContent;
  output_audio?: GoogleGenAIInteractionContent;
  output_video?: GoogleGenAIInteractionContent;
  [key: string]: unknown;
}

export interface GoogleGenAIInteractionSSEEvent {
  event_type?: string;
  interaction?: GoogleGenAIInteraction;
  index?: number;
  step?: GoogleGenAIInteractionStep;
  delta?: Record<string, unknown>;
  metadata?: {
    total_usage?: GoogleGenAIInteractionUsage;
    usage?: GoogleGenAIInteractionUsage;
    [key: string]: unknown;
  };
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

export interface GoogleGenAIInteractionUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number; // This technically exists but we have no sensical way of mapping it to braintrust metrics. Also, the tool use tokens are already counted in output tokens so we don't need to add them.
  [key: string]: unknown;
}
