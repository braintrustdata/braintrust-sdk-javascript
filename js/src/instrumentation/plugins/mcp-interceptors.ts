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
export const mcpChannels = defineInterceptor("mcp", {
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
  transportError: channel<
    [unknown, ...unknown[]],
    unknown,
    { transport: MCPTransport }
  >({ channelName: "transportError" }),
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
});

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
): void {
  wrapMethod(
    transport,
    "handleRequest",
    (original) =>
      function (this: unknown, ...args) {
        return mcpChannels.httpRequest.invoke(
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
            );
          }
          if (protocol.fallbackNotificationHandler) {
            protocol.fallbackNotificationHandler = wrapMCPNotificationHandler(
              protocol.fallbackNotificationHandler,
              protocol,
            );
          }
          return mcpChannels.message.invoke(
            original,
            this,
            args as [unknown, ...unknown[]],
            { transport },
          );
        },
    );
    wrapMethod(
      transport,
      "onerror",
      (original) =>
        function (this: unknown, ...args) {
          return mcpChannels.transportError.invoke(
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
          return mcpChannels.close.invoke(original, this, args, { transport });
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
        return mcpChannels.send.invoke(
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
): MCPRequestHandler {
  if (Reflect.get(handler, wrapped) === protocol) return handler;
  const replacement: MCPRequestHandler = function (
    this: unknown,
    request,
    extra,
  ) {
    return mcpChannels.requestHandler.invoke(handler, this, [request, extra], {
      protocol,
    });
  };
  Object.defineProperty(replacement, wrapped, { value: protocol });
  return replacement;
}

export function wrapMCPProtocol(protocol: MCPProtocol): void {
  wrapMethod(
    protocol,
    "connect",
    (original) =>
      function (this: unknown, ...args) {
        return mcpChannels.connect.invoke(
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
            wrapMCPNotificationHandler(handler, protocol),
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
        return mcpChannels.protocolError.invoke(original, this, [error], {});
      },
  );
  for (const [method, handler] of protocol._requestHandlers ?? []) {
    protocol._requestHandlers!.set(
      method,
      wrapMCPRequestHandler(handler, protocol),
    );
  }
  for (const [method, handler] of protocol._notificationHandlers ?? []) {
    protocol._notificationHandlers!.set(
      method,
      wrapMCPNotificationHandler(handler, protocol),
    );
  }
  if (protocol.transport) wrapMCPTransport(protocol.transport, protocol);
}

function wrapMCPNotificationHandler(
  handler: MCPNotificationHandler,
  protocol: MCPProtocol,
): MCPNotificationHandler {
  if (Reflect.get(handler, wrapped) === protocol) return handler;
  const replacement: MCPNotificationHandler = function (
    this: unknown,
    ...args
  ) {
    return mcpChannels.notificationHandler.invoke(handler, this, args, {
      protocol,
    });
  };
  Object.defineProperty(replacement, wrapped, { value: protocol });
  return replacement;
}
