import type { FastMCPSession } from "../../vendor-sdk-types/fastmcp";
import type { MCPProtocol } from "../../vendor-sdk-types/mcp";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type { MCPIntegrationConfig } from "../config";
import { runInstrumentation } from "../core/observe-result";
import { fastMCPChannels } from "./fastmcp-interceptors";
import { wrapMCPProtocol, wrapMCPTransport } from "./mcp-interceptors";
import { registerMCPTracing } from "./mcp-tracing-plugin";

export function registerFastMCPInstrumentation(
  config: MCPIntegrationConfig = {},
): void {
  registerMCPTracing(fastMCPChannels, config, INSTRUMENTATION_NAMES.FASTMCP);
  void [
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
  ];
}
