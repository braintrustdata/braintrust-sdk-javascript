import { channel, defineInterceptor } from "../core/interceptor-definitions";

import type {
  MCPProtocol,
  MCPRequest,
  MCPRequestHandler,
  MCPRequestHandlerExtra,
} from "../../vendor-sdk-types/mcp";

const setRequestHandlerChannel = channel<unknown[], void>({
  channelName: "Protocol.setRequestHandler",
});

export const mcpSDKChannels = defineInterceptor("@modelcontextprotocol/sdk", {
  setRequestHandler: setRequestHandlerChannel,
});

export const mcpServerChannels = defineInterceptor(
  "@modelcontextprotocol/server",
  {
    setRequestHandler: setRequestHandlerChannel,
  },
);

export const mcpChannels = defineInterceptor("mcp", {
  requestHandler: channel<
    [MCPRequest, MCPRequestHandlerExtra],
    unknown,
    { protocol: MCPProtocol }
  >({
    channelName: "requestHandler",
  }),
});

const requestHandlerWrappers = new WeakSet<MCPRequestHandler>();
const protocolsWithWrappedHandlers = new WeakSet<MCPProtocol>();

/** Whether request handlers of `protocol` already pass through the `requestHandler` hook. */
export function hasWrappedMCPRequestHandlers(protocol: MCPProtocol): boolean {
  return protocolsWithWrappedHandlers.has(protocol);
}

/** Route every invocation of a registered request handler through the `requestHandler` hook. */
export function wrapMCPRequestHandler(
  handler: MCPRequestHandler,
  protocol: MCPProtocol,
): MCPRequestHandler {
  protocolsWithWrappedHandlers.add(protocol);
  if (requestHandlerWrappers.has(handler)) {
    return handler;
  }

  const wrapped: MCPRequestHandler = function (this: unknown, request, extra) {
    return mcpChannels.requestHandler.invoke(handler, this, [request, extra], {
      protocol,
    });
  };
  requestHandlerWrappers.add(wrapped);
  return wrapped;
}
