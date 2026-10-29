import type { MCPProtocol, MCPTransport } from "./mcp";

/** Vendored FastMCP 3.35+ and 4.x surface used by instrumentation. */
export interface FastMCPSession {
  readonly server: MCPProtocol;
  connect(transport: MCPTransport): Promise<void>;
}

export interface FastMCPModule {
  FastMCPSession: { prototype: FastMCPSession };
}
