import { channel, defineInterceptor } from "../core/channel-definitions";

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
  PromiseLike<BedrockRuntimeSendResult>,
  BedrockRuntimeChannelContext,
  BedrockRuntimeStreamEvent
>({
  channelName: "client.send",
});

export const bedrockRuntimeChannels = defineInterceptor("aws-bedrock-runtime", {
  clientSend: clientSendChannel,
});

export const smithyCoreChannels = defineInterceptor("@smithy/core", {
  clientSend: clientSendChannel,
});

export const smithyClientChannels = defineInterceptor("@smithy/smithy-client", {
  clientSend: clientSendChannel,
});
