import { registerInstrumentation } from "../instrumentation/registrations/mcp";
import { debugLogger } from "../debug-logger";
import { isObject } from "../../util/index";
import { wrapMCPProtocol } from "../instrumentation/providers/mcp-interceptors";
import type { MCPProtocol } from "../vendor-sdk-types/mcp";

/**
 * Trace incoming MCP requests through response sending. Accepts an `McpServer`
 * or low-level `Server` from `@modelcontextprotocol/sdk` or
 * `@modelcontextprotocol/server`, and returns the same instance.
 */
export function wrapMCPServer<T>(server: T): T {
  const protocol =
    isObject(server) && isObject(server.server) ? server.server : server;
  if (
    !isObject(protocol) ||
    typeof protocol.connect !== "function" ||
    typeof protocol.setRequestHandler !== "function"
  ) {
    debugLogger.notice.warn("Unsupported MCP server. Not wrapping.");
    return server;
  }
  registerInstrumentation();
  wrapMCPProtocol(protocol as MCPProtocol);
  return server;
}
