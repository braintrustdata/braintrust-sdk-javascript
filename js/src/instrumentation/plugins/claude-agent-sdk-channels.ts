import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  ClaudeAgentSDKMessage,
  ClaudeAgentSDKQueryParams,
} from "../../vendor-sdk-types/claude-agent-sdk";

export const claudeAgentSDKChannels = defineInterceptor(
  "@anthropic-ai/claude-agent-sdk",
  {
    query: channel<
      [ClaudeAgentSDKQueryParams],
      AsyncIterable<ClaudeAgentSDKMessage>,
      Record<never, never>,
      ClaudeAgentSDKMessage
    >({
      channelName: "query",
    }),
  },
);
