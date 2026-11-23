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
  decisions?: GoogleGenAIDecisions;
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
  generateImages: (
    params: GoogleGenAIGenerateImagesParams,
  ) => Promise<GoogleGenAIGenerateImagesResponse>;
  editImage: (
    params: GoogleGenAIEditImageParams,
  ) => Promise<GoogleGenAIEditImageResponse>;
  generateVideos: (
    params: GoogleGenAIGenerateVideosParams,
  ) => Promise<GoogleGenAIGenerateVideosOperation>;
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

export interface GoogleGenAIDecisions {
  create: (
    params: GoogleGenAIDecisionCreateParams,
    options?: Record<string, unknown>,
  ) => Promise<GoogleGenAIDecisionResponse>;
}

export interface GoogleGenAIDecisionCreateParams {
  model: string;
  input:
    | string
    | GoogleGenAIInteractionContent
    | GoogleGenAIInteractionContent[];
  questions: Record<
    string,
    {
      type: "noul" | "choice" | "score";
      instructions:
        | string
        | GoogleGenAIInteractionContent
        | GoogleGenAIInteractionContent[];
      criteria?: Record<string, string> | string[];
    }
  >;
  api_version?: string;
}

export interface GoogleGenAIDecisionResponse {
  answers?: Record<
    string,
    {
      type: "noul" | "choice" | "score";
      confidence: number;
      noul?: number;
      choice?: string;
      score?: number;
      probabilities?: Record<string, number>;
      legend?: Record<string, string>;
    }
  >;
  prompt_feedback?: Record<string, unknown>;
  usage?: GoogleGenAIInteractionUsage;
}

// Requests

export interface GoogleGenAIGenerateContentParams {
  model: string;
  contents: string | GoogleGenAIContent | GoogleGenAIContent[];
  config?: {
    serviceTier?: string;
    tools?: {
      functionDeclarations?: Record<string, unknown>[];
      [key: string]: unknown;
    }[];
    toJSON?: () => Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type GoogleGenAIEmbeddingContent =
  | string
  | GoogleGenAIPart
  | GoogleGenAIContent
  | (string | GoogleGenAIPart)[];

export interface GoogleGenAIEmbedContentParams {
  model: string;
  contents: GoogleGenAIEmbeddingContent | GoogleGenAIEmbeddingContent[];
  config?: {
    outputDimensionality?: number;
    taskType?: string;
    toJSON?: () => Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GoogleGenAIGenerateImagesParams {
  model: string;
  prompt: string;
  config?: {
    aspectRatio?: string;
    imageSize?: string;
    numberOfImages?: number;
    outputMimeType?: string;
    seed?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GoogleGenAIImage {
  gcsUri?: string;
  imageBytes?: string;
  mimeType?: string;
}

export interface GoogleGenAIReferenceImage {
  referenceImage?: GoogleGenAIImage;
  referenceId?: number;
  referenceType?: string;
  [key: string]: unknown;
}

export interface GoogleGenAIEditImageParams {
  model: string;
  prompt: string;
  referenceImages: GoogleGenAIReferenceImage[];
  config?: {
    aspectRatio?: string;
    numberOfImages?: number;
    outputCompressionQuality?: number;
    outputMimeType?: string;
    seed?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GoogleGenAIVideo {
  uri?: string;
  videoBytes?: string;
  mimeType?: string;
}

export interface GoogleGenAIGenerateVideosParams {
  model: string;
  prompt?: string;
  image?: GoogleGenAIImage;
  video?: GoogleGenAIVideo;
  source?: {
    prompt?: string;
    image?: GoogleGenAIImage;
    video?: GoogleGenAIVideo;
  };
  config?: {
    aspectRatio?: string;
    durationSeconds?: number;
    lastFrame?: GoogleGenAIImage;
    mask?: { image?: GoogleGenAIImage };
    referenceImages?: Array<{ image?: GoogleGenAIImage }>;
    resolution?: string;
    seed?: number;
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
    displayName?: string;
  };
  fileData?: {
    fileUri: string;
    mimeType?: string;
    displayName?: string;
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
  promptFeedback?: Record<string, unknown>;
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

export interface GoogleGenAIHttpResponse {
  json(): Promise<GoogleGenAIEmbedContentResponse>;
}

export interface GoogleGenAIEmbedContentResponse {
  embedding?: GoogleGenAIEmbedding;
  embeddings?: GoogleGenAIEmbedding[];
  metadata?: GoogleGenAIEmbedContentMetadata;
  usageMetadata?: GoogleGenAIUsageMetadata & {
    // Embeddings use the singular "Token", unlike generateContent responses.
    promptTokenDetails?: GoogleGenAIModalityTokenCount[];
  };
  [key: string]: unknown;
}

export interface GoogleGenAIGeneratedImage {
  image?: {
    gcsUri?: string;
    imageBytes?: string;
    mimeType?: string;
  };
  enhancedPrompt?: string;
  raiFilteredReason?: string;
  safetyAttributes?: Record<string, unknown>;
}

export interface GoogleGenAIGenerateImagesResponse {
  generatedImages?: GoogleGenAIGeneratedImage[];
  positivePromptSafetyAttributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export type GoogleGenAIEditImageResponse = GoogleGenAIGenerateImagesResponse;

export interface GoogleGenAIGeneratedVideo {
  video?: GoogleGenAIVideo;
}

export interface GoogleGenAIGenerateVideosOperation {
  done?: boolean;
  error?: Record<string, unknown>;
  name?: string;
  response?: {
    generatedVideos?: GoogleGenAIGeneratedVideo[];
  };
  [key: string]: unknown;
}

export interface GoogleGenAIInteraction {
  service_tier?: string;
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
  serviceTier?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: GoogleGenAIModalityTokenCount[];
  cacheTokensDetails?: GoogleGenAIModalityTokenCount[];
  candidatesTokensDetails?: GoogleGenAIModalityTokenCount[];
  toolUsePromptTokensDetails?: GoogleGenAIModalityTokenCount[];
}

export interface GoogleGenAIModalityTokenCount {
  modality?: string;
  tokenCount?: number;
}

export interface GoogleGenAIInteractionModalityTokens {
  modality?: string;
  tokens?: number;
  [key: string]: unknown;
}

export interface GoogleGenAIInteractionUsage {
  cached_tokens_by_modality?: GoogleGenAIInteractionModalityTokens[];
  input_tokens_by_modality?: GoogleGenAIInteractionModalityTokens[];
  output_tokens_by_modality?: GoogleGenAIInteractionModalityTokens[];
  tool_use_tokens_by_modality?: GoogleGenAIInteractionModalityTokens[];
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_tokens?: number;
  total_cached_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number; // This technically exists but we have no sensical way of mapping it to braintrust metrics. Also, the tool use tokens are already counted in output tokens so we don't need to add them.
  [key: string]: unknown;
}
