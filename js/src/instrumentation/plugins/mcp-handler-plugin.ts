import type { MCPProtocol } from "../../vendor-sdk-types/mcp";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type { MCPIntegrationConfig } from "../config";
import { BasePlugin } from "../core";
import { runInstrumentation } from "../core/observe-result";
import { unsubscribeAll } from "../core/tracing";
import { mcpHandlerChannels } from "./mcp-handler-interceptors";
import { wrapMCPProtocol, wrapMCPTransport } from "./mcp-interceptors";
import {
  traceMCPMessage,
  traceMCPSend,
  traceMCPClose,
  traceMCPHandler,
  traceMCPProtocolError,
  traceMCPNotificationHandler,
  traceMCPHttpRequest,
} from "./mcp-tracing";

export class MCPHandlerPlugin extends BasePlugin {
  constructor(private readonly config: MCPIntegrationConfig = {}) {
    super();
  }

  protected onEnable(): void {
    this.unsubscribers.push(
      mcpHandlerChannels.createMcpHandler.intercept(
        (target, receiver, args) => {
          const [initializeServer, ...options] = args;
          return Reflect.apply(target, receiver, [
            function (
              this: unknown,
              ...initArgs: Parameters<typeof initializeServer>
            ) {
              runInstrumentation(() =>
                wrapMCPProtocol(initArgs[0].server, mcpHandlerChannels),
              );
              return Reflect.apply(initializeServer, this, initArgs);
            },
            ...options,
          ]);
        },
      ),
      mcpHandlerChannels.connect.intercept((target, receiver, args) => {
        runInstrumentation(() =>
          wrapMCPTransport(
            args[0],
            receiver as MCPProtocol,
            mcpHandlerChannels,
          ),
        );
        return Reflect.apply(target, receiver, args);
      }),
      mcpHandlerChannels.message.intercept(
        (target, receiver, args, { transport }) =>
          traceMCPMessage(
            () => Reflect.apply(target, receiver, args),
            transport,
            args[0],
            this.config,
            INSTRUMENTATION_NAMES.MCP_HANDLER,
          ),
      ),
      mcpHandlerChannels.send.intercept(
        (target, receiver, args, { transport }) =>
          traceMCPSend(
            () => Reflect.apply(target, receiver, args),
            transport,
            args[0],
            args[1],
            this.config,
            INSTRUMENTATION_NAMES.MCP_HANDLER,
          ),
      ),
      mcpHandlerChannels.close.intercept(
        (target, receiver, args, { transport }) =>
          traceMCPClose(() => Reflect.apply(target, receiver, args), transport),
      ),
      mcpHandlerChannels.requestHandler.intercept(
        (target, receiver, args, { protocol }) =>
          traceMCPHandler(
            () => Reflect.apply(target, receiver, args),
            protocol,
            args[0],
            args[1],
          ),
      ),
      mcpHandlerChannels.protocolError.intercept((target, receiver, args) =>
        traceMCPProtocolError(
          () => Reflect.apply(target, receiver, args),
          args[0],
        ),
      ),
      mcpHandlerChannels.notificationHandler.intercept(
        (target, receiver, args, { protocol }) =>
          traceMCPNotificationHandler(
            () => Reflect.apply(target, receiver, args),
            protocol,
          ),
      ),
      mcpHandlerChannels.httpRequest.intercept(
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
