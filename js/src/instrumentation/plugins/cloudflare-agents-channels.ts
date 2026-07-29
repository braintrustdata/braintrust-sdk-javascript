import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  CloudflareAgentToolClass,
  CloudflareRunAgentToolOptions,
  CloudflareRunAgentToolResult,
} from "../../vendor-sdk-types/cloudflare-agents";

type CloudflareAgentsChannelContext = {
  self?: unknown;
};

export const cloudflareAgentsChannels = defineChannels(
  "agents",
  {
    runAgentTool: channel<
      [CloudflareAgentToolClass, CloudflareRunAgentToolOptions],
      CloudflareRunAgentToolResult,
      CloudflareAgentsChannelContext
    >({
      channelName: "Agent.runAgentTool",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.CLOUDFLARE_AGENTS },
);
