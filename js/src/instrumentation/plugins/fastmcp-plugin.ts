import type { FastMCPSession } from "../../vendor-sdk-types/fastmcp";
import type { MCPProtocol } from "../../vendor-sdk-types/mcp";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type { MCPIntegrationConfig } from "../config";
import { runInstrumentation } from "../core/observe-result";
import { fastMCPChannels } from "./fastmcp-interceptors";
import { wrapMCPProtocol, wrapMCPTransport } from "./mcp-interceptors";
import { MCPTracingPlugin } from "./mcp-tracing-plugin";

export class FastMCPPlugin extends MCPTracingPlugin {
  constructor(config: MCPIntegrationConfig = {}) {
    super(fastMCPChannels, config, INSTRUMENTATION_NAMES.FASTMCP);
  }

  protected onEnable(): void {
    super.onEnable();
    this.unsubscribers.push(
      fastMCPChannels.sessionConnect.intercept((target, receiver, args) => {
        runInstrumentation(() => {
          const protocol = (receiver as FastMCPSession).server;
          wrapMCPProtocol(protocol, fastMCPChannels);
          wrapMCPTransport(args[0], protocol, fastMCPChannels);
        });
        return Reflect.apply(target, receiver, args);
      }),
      fastMCPChannels.connect.intercept((target, receiver, args) => {
        runInstrumentation(() => {
          const protocol = receiver as MCPProtocol;
          wrapMCPTransport(args[0], protocol, fastMCPChannels);
        });
        return Reflect.apply(target, receiver, args);
      }),
    );
  }
}
