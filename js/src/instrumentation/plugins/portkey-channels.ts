import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  PortkeyChatCompletion,
  PortkeyChatCompletionChunk,
  PortkeyChatCreateParams,
  PortkeyChatStream,
} from "../../vendor-sdk-types/portkey";

// Portkey's chat API uses OpenAI-compatible requests and responses, but takes
// gateway configuration and HTTP request options as separate arguments.
export const portkeyChannels = defineChannels(
  "portkey-ai",
  {
    chatCompletionsCreate: channel<
      [PortkeyChatCreateParams, unknown?, unknown?],
      PortkeyChatCompletion | PortkeyChatStream,
      Record<string, unknown>,
      PortkeyChatCompletionChunk
    >({ channelName: "chat.completions.create", kind: "async" }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.PORTKEY },
);
