/**
 * Minimal types for the Cloudflare Agents APIs used by our instrumentation.
 *
 * Keep this file intentionally narrow so `braintrust` does not take a runtime
 * or type dependency on `agents`.
 */

export interface CloudflareAgentToolClass {
  readonly name: string;
  [key: PropertyKey]: unknown;
}

export interface CloudflareRunAgentToolOptions {
  input: unknown;
  detached?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CloudflareRunAgentToolResult {
  status: unknown;
  output?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface CloudflareAgent {
  runAgentTool(
    cls: CloudflareAgentToolClass,
    options: CloudflareRunAgentToolOptions,
  ): Promise<CloudflareRunAgentToolResult>;
  [key: PropertyKey]: unknown;
}
