import type { MCPProtocol } from "./mcp";

/** Relevant public API shared by mcp-handler v1 and v2. */
export type MCPHandlerInitializer = (
  server: { server: MCPProtocol },
  ...args: unknown[]
) => unknown;

export type MCPHandlerCreator = (
  initializeServer: MCPHandlerInitializer,
  ...options: unknown[]
) => (request: Request) => Promise<Response>;
