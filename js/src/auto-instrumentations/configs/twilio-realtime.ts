import type { InstrumentationConfig } from "../orchestrion-js";
import {
  twilioRealtimeChannels,
  realtimeSendChannels,
} from "../../instrumentation/plugins/twilio-realtime-channels";
// Narrowly pinned until additional adapter versions have been validated.
export const twilioRealtimeConfigs: InstrumentationConfig[] = [
  "mjs",
  "js",
].flatMap((ext) => [
  {
    channelName: twilioRealtimeChannels.connect.channelName,
    module: {
      name: "@openai/agents-extensions",
      versionRange: "0.18.0",
      filePath: `dist/TwilioRealtimeTransport.${ext}`,
    },
    functionQuery: {
      className: "TwilioRealtimeTransportLayer",
      methodName: "connect",
      kind: "Async",
    },
  },
  {
    channelName: twilioRealtimeChannels.clear.channelName,
    module: {
      name: "@openai/agents-extensions",
      versionRange: "0.18.0",
      filePath: `dist/TwilioRealtimeTransport.${ext}`,
    },
    functionQuery: {
      className: "TwilioRealtimeTransportLayer",
      privateMethodName: "clearTwilioAudio",
      kind: "Sync",
    },
  },
  {
    channelName: realtimeSendChannels.send.channelName,
    module: {
      name: "@openai/agents-realtime",
      versionRange: "0.18.0",
      filePath: `dist/openaiRealtimeWebsocket.${ext}`,
    },
    functionQuery: {
      className: "OpenAIRealtimeWebSocket",
      methodName: "sendEvent",
      kind: "Sync",
    },
  },
]);
