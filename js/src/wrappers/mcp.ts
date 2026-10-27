import { debugLogger } from "../debug-logger";
import { isObject } from "../../util/index";
import {
  hasWrappedMCPRequestHandlers,
  wrapMCPRequestHandler,
} from "../instrumentation/plugins/mcp-interceptors";
import type { MCPProtocol, MCPRequestHandler } from "../vendor-sdk-types/mcp";

const wrappedProtocols = new WeakSet<MCPProtocol>();

/**
 * Trace MCP requests handled by a server from `@modelcontextprotocol/sdk` or
 * `@modelcontextprotocol/server`. Accepts an `McpServer` or a low-level
 * `Server` and returns the same instance.
 *
 * `McpServer` registers request handlers internally, so the underlying
 * protocol instance is patched in place: handlers registered before and after
 * wrapping pass through the Braintrust instrumentation hooks.
 */
export function wrapMCPServer<T>(server: T): T {
  const protocol = getProtocol(server);
  if (!protocol) {
    debugLogger.notice.warn("Unsupported MCP server. Not wrapping.");
    return server;
  }
  // Auto-instrumentation already routes every registered handler through the hook.
  if (
    wrappedProtocols.has(protocol) ||
    hasWrappedMCPRequestHandlers(protocol)
  ) {
    return server;
  }
  wrappedProtocols.add(protocol);

  const setRequestHandler = protocol.setRequestHandler;
  protocol.setRequestHandler = function (this: unknown, ...args: unknown[]) {
    // v1 passes `(schema, handler)` and v2 `(method, handler)`. v2 custom
    // methods pass `(method, schemas, handler)` and are never traced.
    if (typeof args[1] === "function") {
      args[1] = wrapMCPRequestHandler(args[1] as MCPRequestHandler, protocol);
    }
    return Reflect.apply(setRequestHandler, this, args);
  };

  // `McpServer` registers handlers for capabilities declared in its options
  // during construction.
  const handlers = protocol._requestHandlers;
  if (handlers instanceof Map) {
    for (const [method, handler] of handlers) {
      handlers.set(method, wrapMCPRequestHandler(handler, protocol));
    }
  }

  return server;
}

function isProtocol(value: unknown): value is MCPProtocol {
  return isObject(value) && typeof value.setRequestHandler === "function";
}

function getProtocol(server: unknown): MCPProtocol | undefined {
  // `McpServer` exposes the underlying low-level `Server` as `server`.
  if (isObject(server) && isProtocol(server.server)) {
    return server.server;
  }
  return isProtocol(server) ? server : undefined;
}
