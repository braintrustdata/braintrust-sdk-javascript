import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  CloudflareAgentToolClass,
  CloudflareRunAgentToolOptions,
  CloudflareRunAgentToolResult,
} from "../../vendor-sdk-types/cloudflare-agents";

type CloudflareAgentsChannelContext = {
  self?: unknown;
};

export const cloudflareAgentsChannels = defineInterceptor("agents", {
  runAgentTool: channel<
    [CloudflareAgentToolClass, CloudflareRunAgentToolOptions],
    PromiseLike<CloudflareRunAgentToolResult>,
    CloudflareAgentsChannelContext
  >({
    channelName: "Agent.runAgentTool",
  }),
});
