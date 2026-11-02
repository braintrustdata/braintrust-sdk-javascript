import { channel, defineInterceptor } from "../core/interceptor-definitions";
import type { MCPHandlerCreator } from "../../vendor-sdk-types/mcp-handler";
import { mcpChannelDefinitions } from "./mcp-interceptors";

export const mcpHandlerChannels = defineInterceptor("mcp-handler", {
  ...mcpChannelDefinitions,
  createMcpHandler: channel<
    Parameters<MCPHandlerCreator>,
    ReturnType<MCPHandlerCreator>
  >({ channelName: "createMcpHandler" }),
});
