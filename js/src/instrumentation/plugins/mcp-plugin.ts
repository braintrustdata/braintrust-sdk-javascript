import type {
  MCPProtocol,
  MCPRequestHandler,
} from "../../vendor-sdk-types/mcp";
import { BasePlugin } from "../core";
import type { MCPIntegrationConfig } from "../config";
import { unsubscribeAll } from "../core/tracing";
import { runInstrumentation } from "../core/observe-result";
import {
  mcpChannels,
  mcpSDKChannels,
  mcpServerChannels,
  wrapMCPProtocol,
  wrapMCPTransport,
  wrapMCPRequestHandler,
} from "./mcp-interceptors";
import {
  traceMCPMessage,
  traceMCPSend,
  traceMCPClose,
  traceMCPHandler,
  traceMCPProtocolError,
  traceMCPNotificationHandler,
  traceMCPHttpRequest,
} from "./mcp-tracing";

export class MCPPlugin extends BasePlugin {
  constructor(private readonly config: MCPIntegrationConfig = {}) {
    super();
  }

  protected onEnable(): void {
    this.unsubscribers.push(
      ...[
        mcpChannels.connect,
        mcpSDKChannels.connect,
        mcpServerChannels.connect,
      ].map((channel) =>
        channel.intercept((target, receiver, args) => {
          const protocol = receiver as MCPProtocol;
          // Protocol is shared with clients. Only servers have a server identity;
          // the manual wrapper's channel is an explicit server opt-in.
          if (
            channel === mcpChannels.connect ||
            protocol._serverInfo !== undefined
          ) {
            runInstrumentation(() => {
              wrapMCPProtocol(protocol);
              wrapMCPTransport(args[0], protocol);
            });
          }
          return Reflect.apply(target, receiver, args);
        }),
      ),
      ...[
        mcpSDKChannels.setRequestHandler,
        mcpServerChannels.setRequestHandler,
      ].map((channel) =>
        channel.intercept((target, receiver, args) => {
          const wrappedArgs = [...args];
          const index = wrappedArgs.length - 1;
          if (typeof wrappedArgs[index] === "function") {
            wrappedArgs[index] = wrapMCPRequestHandler(
              wrappedArgs[index] as MCPRequestHandler,
              receiver as MCPProtocol,
            );
          }
          return Reflect.apply(target, receiver, wrappedArgs);
        }),
      ),
      mcpChannels.message.intercept((target, receiver, args, { transport }) =>
        traceMCPMessage(
          () => Reflect.apply(target, receiver, args),
          transport,
          args[0],
          this.config,
        ),
      ),
      mcpChannels.send.intercept((target, receiver, args, { transport }) =>
        traceMCPSend(
          () => Reflect.apply(target, receiver, args),
          transport,
          args[0],
        ),
      ),
      mcpChannels.close.intercept((target, receiver, args, { transport }) =>
        traceMCPClose(() => Reflect.apply(target, receiver, args), transport),
      ),
      mcpChannels.requestHandler.intercept(
        (target, receiver, args, { protocol }) =>
          traceMCPHandler(
            () => Reflect.apply(target, receiver, args),
            protocol,
            args[0],
            args[1],
          ),
      ),
      mcpChannels.protocolError.intercept((target, receiver, args) =>
        traceMCPProtocolError(
          () => Reflect.apply(target, receiver, args),
          args[0],
        ),
      ),
      mcpChannels.notificationHandler.intercept(
        (target, receiver, args, { protocol }) =>
          traceMCPNotificationHandler(
            () => Reflect.apply(target, receiver, args),
            protocol,
          ),
      ),
      mcpChannels.httpRequest.intercept(
        (target, receiver, args, { transport }) =>
          traceMCPHttpRequest(
            () => Reflect.apply(target, receiver, args),
            transport,
            args[0],
          ),
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}
