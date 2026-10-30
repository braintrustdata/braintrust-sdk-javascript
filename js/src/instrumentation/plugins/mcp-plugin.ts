import type {
  MCPProtocol,
  MCPRequestHandler,
} from "../../vendor-sdk-types/mcp";
import { MCPTracingPlugin } from "./mcp-tracing-plugin";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type { MCPIntegrationConfig } from "../config";
import { runInstrumentation } from "../core/observe-result";
import {
  mcpChannels,
  mcpSDKChannels,
  mcpServerChannels,
  wrapMCPProtocol,
  wrapMCPTransport,
  wrapMCPRequestHandler,
} from "./mcp-interceptors";

export class MCPPlugin extends MCPTracingPlugin {
  constructor(config: MCPIntegrationConfig = {}) {
    super(mcpChannels, config, INSTRUMENTATION_NAMES.MCP);
  }

  protected onEnable(): void {
    super.onEnable();
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
    );
  }
}
