import type { FastMCPSession } from "../../vendor-sdk-types/fastmcp";
import { mcpChannelDefinitions } from "./mcp-interceptors";
import { channel, defineInterceptor } from "../core/interceptor-definitions";

export const fastMCPChannels = defineInterceptor("fastmcp", {
  ...mcpChannelDefinitions,
  sessionConnect: channel<
    Parameters<FastMCPSession["connect"]>,
    ReturnType<FastMCPSession["connect"]>
  >({ channelName: "FastMCPSession.connect" }),
});
