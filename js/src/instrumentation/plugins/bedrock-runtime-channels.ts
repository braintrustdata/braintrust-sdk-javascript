import { channel, defineChannels } from "../core/channel-definitions";
import type {
  BedrockRuntimeChannelContext,
  BedrockRuntimeCommandLike,
  BedrockRuntimeConverseStreamEvent,
  BedrockRuntimeResponseStreamEvent,
  BedrockRuntimeSendResult,
} from "../../vendor-sdk-types/bedrock-runtime";

export type BedrockRuntimeStreamEvent =
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

export const bedrockRuntimeChannels = defineChannels("aws-bedrock-runtime", {
  clientSend: clientSendChannel,
});

export const smithyCoreChannels = defineChannels("@smithy/core", {
  clientSend: clientSendChannel,
});

export const smithyClientChannels = defineChannels("@smithy/smithy-client", {
  clientSend: clientSendChannel,
});
