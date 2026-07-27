export type VoyageAIUsage = {
  totalTokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
};

export type VoyageAIEmbedRequest = {
  input: unknown;
  model: string;
  inputType?: unknown;
  truncation?: boolean;
  encodingFormat?: unknown;
  outputDimension?: number;
  outputDtype?: unknown;
  [key: string]: unknown;
};

export type VoyageAIMultimodalEmbedRequest = {
  inputs: unknown;
  model: string;
  inputType?: unknown;
  truncation?: boolean;
  encodingFormat?: unknown;
  [key: string]: unknown;
};

export type VoyageAIRerankRequest = {
  query: string;
  documents: unknown;
  model: string;
  topK?: number;
  returnDocuments?: boolean;
  truncation?: boolean;
  [key: string]: unknown;
};

export type VoyageAIContextualizedEmbedRequest = {
  inputs: unknown;
  model: string;
  inputType?: unknown;
  outputDimension?: number;
  outputDtype?: unknown;
  [key: string]: unknown;
};

export type VoyageAIEmbeddingDataItem = {
  embedding?: unknown;
  index?: number;
  [key: string]: unknown;
};

export type VoyageAIEmbeddingResponse = {
  data?: VoyageAIEmbeddingDataItem[];
  model?: string;
  usage?: VoyageAIUsage;
  [key: string]: unknown;
};

export type VoyageAIRerankResponse = {
  data?: Array<{
    index?: number;
    relevanceScore?: number;
    relevance_score?: number;
    [key: string]: unknown;
  }>;
  model?: string;
  usage?: VoyageAIUsage;
  [key: string]: unknown;
};

export type VoyageAIContextualizedEmbeddingResponse = {
  data?: Array<{
    data?: VoyageAIEmbeddingDataItem[];
    index?: number;
    [key: string]: unknown;
  }>;
  model?: string;
  usage?: VoyageAIUsage;
  [key: string]: unknown;
};

export type VoyageAIContextualizedEmbedResult = {
  results?: Array<{
    embeddings?: unknown;
    index?: number;
    [key: string]: unknown;
  }>;
  totalTokens?: number;
  rawResponse?: VoyageAIContextualizedEmbeddingResponse;
  [key: string]: unknown;
};

export type VoyageAIContextualizedResult =
  | VoyageAIContextualizedEmbeddingResponse
  | VoyageAIContextualizedEmbedResult;

export type VoyageAIResponsePromise<T> = PromiseLike<T> & {
  withRawResponse?: () => Promise<{
    data: T;
    rawResponse: unknown;
  }>;
};

export type VoyageAIClient = {
  embed?: (
    request: VoyageAIEmbedRequest,
    options?: unknown,
  ) => VoyageAIResponsePromise<VoyageAIEmbeddingResponse>;
  multimodalEmbed?: (
    request: VoyageAIMultimodalEmbedRequest,
    options?: unknown,
  ) => VoyageAIResponsePromise<VoyageAIEmbeddingResponse>;
  rerank?: (
    request: VoyageAIRerankRequest,
    options?: unknown,
  ) => VoyageAIResponsePromise<VoyageAIRerankResponse>;
  contextualizedEmbed?: (
    request: VoyageAIContextualizedEmbedRequest,
    options?: unknown,
  ) => VoyageAIResponsePromise<VoyageAIContextualizedResult>;
  [key: string]: unknown;
};
