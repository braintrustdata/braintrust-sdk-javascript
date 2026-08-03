// @cloudflare/think types

export type CloudflareThinkMessage = {
  role?: string;
  parts?: unknown[];
  content?: unknown;
};

export type CloudflareThinkTurnInput = {
  continuation?: boolean;
  body?: unknown;
};

export type CloudflareThinkStreamableResult = {
  toUIMessageStream?: (...args: unknown[]) => unknown;
};

export type CloudflareThinkInstance = {
  messages?: CloudflareThinkMessage[];
  _runInferenceLoop?: (
    input: CloudflareThinkTurnInput,
  ) => Promise<CloudflareThinkStreamableResult>;
};

export type CloudflareThinkConstructor = {
  prototype: CloudflareThinkInstance & Record<PropertyKey, unknown>;
};

export type CloudflareThinkModule = {
  Think?: CloudflareThinkConstructor;
};
