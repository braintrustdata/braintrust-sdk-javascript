/**
 * Vendored Genkit types used internally by the wrapper and instrumentation.
 *
 * Should never be exposed to users of the SDK.
 */

export type GenkitModelArgument =
  | string
  | {
      name?: string;
      version?: string;
      [key: string]: unknown;
    }
  | {
      model?: string;
      [key: string]: unknown;
    };

export type GenkitPart = {
  text?: string;
  media?: unknown;
  data?: unknown;
  [key: string]: unknown;
};

export type GenkitGenerateOptions = {
  model?: GenkitModelArgument;
  prompt?: string | GenkitPart[];
  system?: string | GenkitPart[];
  messages?: Array<{
    role?: string;
    content?: GenkitPart[];
    [key: string]: unknown;
  }>;
  docs?: unknown;
  tools?: unknown;
  config?: Record<string, unknown>;
  output?: unknown;
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
  [key: string]: unknown;
};

export type GenkitGenerateInput =
  | string
  | GenkitPart[]
  | GenkitGenerateOptions
  | PromiseLike<GenkitGenerateOptions>;

export type GenkitUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtsTokens?: number;
  cachedContentTokens?: number;
  [key: string]: unknown;
};

export type GenkitGenerateResponse = {
  text?: string;
  output?: unknown;
  message?: unknown;
  finishReason?: string;
  finishMessage?: string;
  usage?: GenkitUsage;
  request?: GenkitGenerateOptions;
  model?: string;
  toJSON?: () => unknown;
  [key: string]: unknown;
};

export type GenkitGenerateResponseChunk = {
  text?: string;
  accumulatedText?: string;
  content?: GenkitPart[];
  role?: string;
  [key: string]: unknown;
};

export type GenkitGenerateStreamResponse = {
  stream: AsyncIterable<GenkitGenerateResponseChunk>;
  response: Promise<GenkitGenerateResponse>;
  [key: string]: unknown;
};

export type GenkitEmbedding = number[] | { embedding?: number[] };

export type GenkitEmbedParams = {
  embedder?: GenkitModelArgument;
  content?: unknown;
  metadata?: Record<string, unknown>;
  options?: Record<string, unknown>;
  [key: string]: unknown;
};

export type GenkitEmbedManyParams = {
  embedder?: GenkitModelArgument;
  content?: unknown[];
  metadata?: Record<string, unknown>;
  options?: Record<string, unknown>;
  [key: string]: unknown;
};

export type GenkitActionMetadata = {
  actionType?: string;
  key?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type GenkitActionResult = {
  result?: unknown;
  telemetry?: {
    traceId?: string;
    spanId?: string;
  };
  [key: string]: unknown;
};

export type GenkitAction = {
  (input?: unknown, options?: unknown): Promise<unknown>;
  __action?: GenkitActionMetadata;
  __registry?: unknown;
  run?: (input?: unknown, options?: unknown) => Promise<GenkitActionResult>;
  stream?: (
    input?: unknown,
    options?: unknown,
  ) => {
    stream: AsyncIterable<unknown>;
    output: Promise<unknown>;
  };
  [key: string]: unknown;
};

export type GenkitInstance = {
  generate?: (input: GenkitGenerateInput) => Promise<GenkitGenerateResponse>;
  generateStream?: (input: GenkitGenerateInput) => GenkitGenerateStreamResponse;
  embed?: (params: GenkitEmbedParams) => Promise<GenkitEmbedding[]>;
  embedMany?: (params: GenkitEmbedManyParams) => Promise<unknown>;
  run?: (
    name: string,
    inputOrFn: unknown,
    maybeFn?: (input?: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
  defineFlow?: (...args: unknown[]) => GenkitAction;
  defineTool?: (...args: unknown[]) => GenkitAction;
  [key: string]: unknown;
};
