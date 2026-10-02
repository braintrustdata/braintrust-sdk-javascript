import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  PiAgentSession,
  PiPromptOptions,
} from "../../vendor-sdk-types/pi-coding-agent";

export const piCodingAgentChannels = defineInterceptor(
  "@earendil-works/pi-coding-agent",
  {
    prompt: channel<
      [string, PiPromptOptions | undefined],
      PromiseLike<void>,
      { session?: PiAgentSession }
    >({
      channelName: "AgentSession.prompt",
    }),
  },
);
