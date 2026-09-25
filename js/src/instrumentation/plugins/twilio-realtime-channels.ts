import { INSTRUMENTATION_NAMES } from "../../span-origin";
import { channel, defineChannels } from "../core/channel-definitions";
export const twilioRealtimeChannels = defineChannels(
  "@openai/agents-extensions",
  {
    connect: channel<any[], any>({
      channelName: "twilio.connect",
      kind: "async",
    }),
    clear: channel<any[], any>({
      channelName: "twilio.clear",
      kind: "sync-stream",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.OPENAI_AGENTS },
);
export const realtimeSendChannels = defineChannels(
  "@openai/agents-realtime",
  {
    send: channel<any[], any>({
      channelName: "realtime.sendEvent",
      kind: "sync-stream",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.OPENAI_AGENTS },
);
