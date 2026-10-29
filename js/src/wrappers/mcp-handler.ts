import { debugLogger } from "../debug-logger";
import { mcpHandlerChannels } from "../instrumentation/plugins/mcp-handler-interceptors";
import type { MCPHandlerCreator } from "../vendor-sdk-types/mcp-handler";

const wrappers = new WeakMap<MCPHandlerCreator, MCPHandlerCreator>();

/**
 * Wrap the `createMcpHandler` factory from `mcp-handler` to trace incoming MCP
 * requests with the same conventions as `wrapMCPServer`.
 * Configure this integration with `integrations.mcpHandler`.
 *
 * @example
 * ```ts
 * import { createMcpHandler } from "mcp-handler";
 * import { wrapMCPHandler } from "braintrust";
 *
 * const handler = wrapMCPHandler(createMcpHandler)((server) => {
 *   server.registerTool("hello", {}, async () => ({
 *     content: [{ type: "text", text: "Hello!" }],
 *   }));
 * });
 * ```
 */
export function wrapMCPHandler<T>(createMcpHandler: T): T {
  if (typeof createMcpHandler !== "function") {
    debugLogger.notice.warn("Unsupported MCP handler factory. Not wrapping.");
    return createMcpHandler;
  }
  const factory = createMcpHandler as MCPHandlerCreator;
  const cached = wrappers.get(factory);
  if (cached) return cached as T;

  const wrapped = new Proxy(factory, {
    apply(target, receiver, args: Parameters<MCPHandlerCreator>) {
      return mcpHandlerChannels.createMcpHandler.invoke(
        target,
        receiver,
        args,
        {},
      );
    },
  });
  wrappers.set(factory, wrapped);
  wrappers.set(wrapped, wrapped);
  return wrapped as T;
}
