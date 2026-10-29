import { BasePlugin } from "../core";
import type { MCPIntegrationConfig } from "../config";
import type { SpanInstrumentationName } from "../../span-origin";
import type { MCPChannels } from "./mcp-interceptors";
import { unsubscribeAll } from "../core/tracing";
import {
  traceMCPMessage,
  traceMCPSend,
  traceMCPClose,
  traceMCPHandler,
  traceMCPProtocolError,
  traceMCPNotificationHandler,
  traceMCPHttpRequest,
} from "./mcp-tracing";

/** Shared protocol tracing; each provider registers its own invocation hooks. */
export class MCPTracingPlugin extends BasePlugin {
  constructor(
    private readonly channels: MCPChannels,
    private readonly config: MCPIntegrationConfig,
    private readonly instrumentationName: SpanInstrumentationName,
  ) {
    super();
  }

  protected onEnable(): void {
    const channels = this.channels;
    this.unsubscribers.push(
      channels.message.intercept((target, receiver, args, { transport }) =>
        traceMCPMessage(
          () => Reflect.apply(target, receiver, args),
          transport,
          args[0],
          this.config,
          this.instrumentationName,
        ),
      ),
      channels.send.intercept((target, receiver, args, { transport }) =>
        traceMCPSend(
          () => Reflect.apply(target, receiver, args),
          transport,
          args[0],
          args[1],
          this.config,
          this.instrumentationName,
        ),
      ),
      channels.close.intercept((target, receiver, args, { transport }) =>
        traceMCPClose(() => Reflect.apply(target, receiver, args), transport),
      ),
      channels.requestHandler.intercept(
        (target, receiver, args, { protocol }) =>
          traceMCPHandler(
            () => Reflect.apply(target, receiver, args),
            protocol,
            args[0],
            args[1],
          ),
      ),
      channels.protocolError.intercept((target, receiver, args) =>
        traceMCPProtocolError(
          () => Reflect.apply(target, receiver, args),
          args[0],
        ),
      ),
      channels.notificationHandler.intercept(
        (target, receiver, args, { protocol }) =>
          traceMCPNotificationHandler(
            () => Reflect.apply(target, receiver, args),
            protocol,
          ),
      ),
      channels.httpRequest.intercept((target, receiver, args, { transport }) =>
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
