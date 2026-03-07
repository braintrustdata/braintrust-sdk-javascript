import { channel, defineChannels } from "../core";
import type {
  ClaudeAgentSDKMessage,
  ClaudeAgentSDKQueryParams,
} from "../../vendor-sdk-types/claude-agent-sdk";

export const claudeAgentSDKChannels = defineChannels({
  query: channel<
    [ClaudeAgentSDKQueryParams],
    AsyncIterable<ClaudeAgentSDKMessage>,
    Record<string, never>,
    ClaudeAgentSDKMessage
  >({
    name: "query",
    fullName: "orchestrion:@anthropic-ai/claude-agent-sdk:query",
    kind: "async",
  }),
});
