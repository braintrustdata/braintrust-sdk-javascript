import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  BedrockAgentRuntimeChannelContext,
  BedrockAgentRuntimeCommandLike,
  BedrockAgentRuntimeSendResult,
  BedrockAgentRuntimeStreamEvent,
} from "../../vendor-sdk-types/bedrock-agent-runtime";
import { channel, defineChannels } from "../core/channel-definitions";

const clientSendChannel = channel<
  [BedrockAgentRuntimeCommandLike, unknown?],
  BedrockAgentRuntimeSendResult,
  BedrockAgentRuntimeChannelContext,
  BedrockAgentRuntimeStreamEvent
>({
  channelName: "client.send",
  kind: "async",
});

export const bedrockAgentRuntimeChannels = defineChannels(
  "aws-bedrock-agent-runtime",
  {
    clientSend: clientSendChannel,
  },
  { instrumentationName: INSTRUMENTATION_NAMES.BEDROCK_AGENT_RUNTIME },
);

// These intentionally resolve to the same diagnostics channels as the Bedrock
// Runtime instrumentation. Smithy owns Client.send for both AWS clients.
export const bedrockAgentSmithyCoreChannels = defineChannels(
  "@smithy/core",
  {
    clientSend: clientSendChannel,
  },
  { instrumentationName: INSTRUMENTATION_NAMES.BEDROCK_AGENT_RUNTIME },
);

export const bedrockAgentSmithyClientChannels = defineChannels(
  "@smithy/smithy-client",
  {
    clientSend: clientSendChannel,
  },
  { instrumentationName: INSTRUMENTATION_NAMES.BEDROCK_AGENT_RUNTIME },
);
