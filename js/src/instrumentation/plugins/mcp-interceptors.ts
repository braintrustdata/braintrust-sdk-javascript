import { channel, defineInterceptor } from "../core/interceptor-definitions";
import type {
  MCPProtocol,
  MCPRequest,
  MCPRequestHandler,
  MCPRequestHandlerExtra,
  MCPTransport,
  MCPNotificationHandler,
} from "../../vendor-sdk-types/mcp";

const protocolChannels = {
  connect: channel<[MCPTransport, ...unknown[]], unknown>({
    channelName: "Protocol.connect",
  }),
  setRequestHandler: channel<unknown[], void>({
    channelName: "Protocol.setRequestHandler",
  }),
};
export const mcpSDKChannels = defineInterceptor(
  "@modelcontextprotocol/sdk",
  protocolChannels,
);
export const mcpServerChannels = defineInterceptor(
  "@modelcontextprotocol/server",
  protocolChannels,
);
export const mcpChannelDefinitions = {
  connect: channel<[MCPTransport, ...unknown[]], unknown>({
    channelName: "connect",
  }),
  message: channel<
    [unknown, ...unknown[]],
    unknown,
    { transport: MCPTransport }
  >({ channelName: "message" }),
  send: channel<[unknown, ...unknown[]], unknown, { transport: MCPTransport }>({
    channelName: "send",
  }),
  close: channel<unknown[], unknown, { transport: MCPTransport }>({
    channelName: "close",
  }),
  httpRequest: channel<
    [unknown, ...unknown[]],
    unknown,
    { transport: MCPTransport }
  >({
    channelName: "httpRequest",
  }),
  protocolError: channel<[unknown], unknown>({ channelName: "protocolError" }),
  requestHandler: channel<
    [MCPRequest, MCPRequestHandlerExtra],
    unknown,
    { protocol: MCPProtocol }
  >({ channelName: "requestHandler" }),
  notificationHandler: channel<
    [MCPRequest, ...unknown[]],
    unknown,
    { protocol: MCPProtocol }
  >({ channelName: "notificationHandler" }),
};

export const mcpChannels = defineInterceptor("mcp", mcpChannelDefinitions);
export type MCPChannels = typeof mcpChannels;

const wrapped = Symbol.for("braintrust.mcp.transport-wrapper");
function wrapMethod(
  target: object,
  key: string,
  wrap: (
    original: (...args: unknown[]) => unknown,
  ) => (...args: unknown[]) => unknown,
): void {
  const original = Reflect.get(target, key);
  if (typeof original !== "function" || original[wrapped]) return;
  const replacement = wrap(original);
  Object.defineProperty(replacement, wrapped, { value: true });
  Reflect.set(target, key, replacement);
}

/** Install only generic invocation hooks; tracing is registered by the plugin. */
export function wrapMCPTransport(
  transport: MCPTransport,
  protocol: MCPProtocol,
  channels: MCPChannels = mcpChannels,
): void {
  wrapMethod(
    transport,
    "handleRequest",
    (original) =>
      function (this: unknown, ...args) {
        return channels.httpRequest.invoke(
          original,
          this,
          args as [unknown, ...unknown[]],
          { transport },
        );
      },
  );
  const wrapCallbacks = () => {
    wrapMethod(
      transport,
      "onmessage",
      (original) =>
        function (this: unknown, ...args) {
          // Fallback handlers can be assigned directly, even after connect.
          if (protocol.fallbackRequestHandler) {
            protocol.fallbackRequestHandler = wrapMCPRequestHandler(
              protocol.fallbackRequestHandler,
              protocol,
              channels,
            );
          }
          if (protocol.fallbackNotificationHandler) {
            protocol.fallbackNotificationHandler = wrapMCPNotificationHandler(
              protocol.fallbackNotificationHandler,
              protocol,
              channels,
            );
          }
          return channels.message.invoke(
            original,
            this,
            args as [unknown, ...unknown[]],
            { transport },
          );
        },
    );
    wrapMethod(
      transport,
      "onclose",
      (original) =>
        function (this: unknown, ...args) {
          return channels.close.invoke(original, this, args, { transport });
        },
    );
  };
  // Protocol.connect installs callbacks before calling start, which may deliver
  // queued messages immediately. Also support wrapping an already connected server.
  wrapMethod(
    transport,
    "start",
    (original) =>
      function (this: unknown, ...args) {
        wrapCallbacks();
        return Reflect.apply(original, this, args);
      },
  );
  wrapMethod(
    transport,
    "send",
    (original) =>
      function (this: unknown, ...args) {
        return channels.send.invoke(
          original,
          this,
          args as [unknown, ...unknown[]],
          { transport },
        );
      },
  );
  wrapCallbacks();
}

export function wrapMCPRequestHandler(
  handler: MCPRequestHandler,
  protocol: MCPProtocol,
  channels: MCPChannels = mcpChannels,
): MCPRequestHandler {
  if (Reflect.get(handler, wrapped) === protocol) return handler;
  const replacement: MCPRequestHandler = function (
    this: unknown,
    request,
    extra,
  ) {
    return channels.requestHandler.invoke(handler, this, [request, extra], {
      protocol,
    });
  };
  Object.defineProperty(replacement, wrapped, { value: protocol });
  return replacement;
}

export function wrapMCPProtocol(
  protocol: MCPProtocol,
  channels: MCPChannels = mcpChannels,
): void {
  wrapMethod(
    protocol,
    "connect",
    (original) =>
      function (this: unknown, ...args) {
        return channels.connect.invoke(
          original,
          this,
          args as [MCPTransport, ...unknown[]],
          {},
        );
      },
  );
  wrapMethod(
    protocol,
    "setRequestHandler",
    (original) =>
      function (this: unknown, ...args) {
        const index = args.length - 1;
        if (typeof args[index] === "function")
          args[index] = wrapMCPRequestHandler(
            args[index] as MCPRequestHandler,
            protocol,
            channels,
          );
        return Reflect.apply(original, this, args);
      },
  );
  wrapMethod(
    protocol,
    "setNotificationHandler",
    (original) =>
      function (this: unknown, ...args) {
        const result = Reflect.apply(original, this, args);
        // Observe the SDK's validation wrapper as well as the user callback.
        for (const [method, handler] of protocol._notificationHandlers ?? []) {
          protocol._notificationHandlers!.set(
            method,
            wrapMCPNotificationHandler(handler, protocol, channels),
          );
        }
        return result;
      },
  );
  wrapMethod(
    protocol,
    "_onerror",
    (original) =>
      function (this: unknown, error) {
        return channels.protocolError.invoke(original, this, [error], {});
      },
  );
  for (const [method, handler] of protocol._requestHandlers ?? []) {
    protocol._requestHandlers!.set(
      method,
      wrapMCPRequestHandler(handler, protocol, channels),
    );
  }
  for (const [method, handler] of protocol._notificationHandlers ?? []) {
    protocol._notificationHandlers!.set(
      method,
      wrapMCPNotificationHandler(handler, protocol, channels),
    );
  }
  if (protocol.transport)
    wrapMCPTransport(protocol.transport, protocol, channels);
}

function wrapMCPNotificationHandler(
  handler: MCPNotificationHandler,
  protocol: MCPProtocol,
  channels: MCPChannels = mcpChannels,
): MCPNotificationHandler {
  if (Reflect.get(handler, wrapped) === protocol) return handler;
  const replacement: MCPNotificationHandler = function (
    this: unknown,
    ...args
  ) {
    return channels.notificationHandler.invoke(handler, this, args, {
      protocol,
    });
  };
  Object.defineProperty(replacement, wrapped, { value: protocol });
  return replacement;
}
