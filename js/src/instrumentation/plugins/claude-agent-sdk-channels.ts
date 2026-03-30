import { channel, defineChannels } from "../core/channel-definitions";
import type {
  ClaudeAgentSDKMessage,
  ClaudeAgentSDKQueryParams,
} from "../../vendor-sdk-types/claude-agent-sdk";

export const claudeAgentSDKChannels = defineChannels(
  "@anthropic-ai/claude-agent-sdk",
  {
    query: channel<
      [ClaudeAgentSDKQueryParams],
      AsyncIterable<ClaudeAgentSDKMessage>,
      Record<string, never>,
      ClaudeAgentSDKMessage
    >({
      channelName: "query",
      kind: "sync-stream",
    }),
  },
);
