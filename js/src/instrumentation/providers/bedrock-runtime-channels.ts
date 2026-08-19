import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  BedrockRuntimeChannelContext,
  BedrockRuntimeCommandLike,
  BedrockRuntimeConverseStreamEvent,
  BedrockRuntimeResponseStreamEvent,
  BedrockRuntimeSendResult,
} from "../../vendor-sdk-types/bedrock-runtime";

type BedrockRuntimeStreamEvent =
  | BedrockRuntimeConverseStreamEvent
  | BedrockRuntimeResponseStreamEvent;

const clientSendChannel = channel<
  [BedrockRuntimeCommandLike, unknown?],
  BedrockRuntimeSendResult,
  BedrockRuntimeChannelContext,
  BedrockRuntimeStreamEvent
>({
  channelName: "client.send",
  kind: "async",
});

export const bedrockRuntimeChannels = defineChannels(
  "aws-bedrock-runtime",
  {
    clientSend: clientSendChannel,
  },
  { instrumentationName: INSTRUMENTATION_NAMES.BEDROCK_RUNTIME },
);

export const smithyCoreChannels = defineChannels(
  "@smithy/core",
  {
    clientSend: clientSendChannel,
  },
  { instrumentationName: INSTRUMENTATION_NAMES.BEDROCK_RUNTIME },
);

export const smithyClientChannels = defineChannels(
  "@smithy/smithy-client",
  {
    clientSend: clientSendChannel,
  },
  { instrumentationName: INSTRUMENTATION_NAMES.BEDROCK_RUNTIME },
);
