import { channel, defineChannels } from "../core/channel-definitions";
import type {
  PiAgentSession,
  PiPromptOptions,
} from "../../vendor-sdk-types/pi-coding-agent";

export const piCodingAgentChannels = defineChannels(
  "@earendil-works/pi-coding-agent",
  {
    prompt: channel<
      [string, PiPromptOptions | undefined],
      void,
      { session?: PiAgentSession }
    >({
      channelName: "AgentSession.prompt",
      kind: "async",
    }),
  },
);
