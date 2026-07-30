/**
 * Vendored types for @cloudflare/ai-chat used by Braintrust instrumentation.
 *
 * Keep this surface intentionally narrow. These types are not exported to SDK
 * users and only cover fields that the instrumentation reads or wraps.
 */

export interface CloudflareAIChatModule {
  AIChatAgent?: CloudflareAIChatAgentConstructor;
  [key: string]: unknown;
}

export interface CloudflareAIChatAgentConstructor {
  new (...args: unknown[]): CloudflareAIChatAgent;
  [key: string | symbol]: unknown;
}

export interface CloudflareAIChatAgent {
  readonly messages?: CloudflareAIChatMessage[];
  _runExclusiveChatTurn(
    requestId: string,
    callback: CloudflareAIChatTurnCallback,
    options?: CloudflareAIChatTurnOptions,
  ): Promise<unknown>;
  onChatResponse(result: CloudflareAIChatResponseResult): unknown;
  [key: string | symbol]: unknown;
}

export type CloudflareAIChatTurnCallback = () => Promise<unknown>;

export interface CloudflareAIChatTurnOptions {
  epoch?: number;
  onStale?: () => void;
  [key: string]: unknown;
}

export interface CloudflareAIChatMessage {
  id?: string;
  role?: string;
  parts?: unknown[];
  [key: string]: unknown;
}

export interface CloudflareAIChatResponseResult {
  message?: CloudflareAIChatMessage;
  requestId?: string;
  continuation?: boolean;
  status?: "completed" | "error" | "aborted" | string;
  error?: unknown;
  [key: string]: unknown;
}
