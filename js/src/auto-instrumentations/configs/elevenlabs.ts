import type { InstrumentationConfig } from "../orchestrion-js";
import { elevenLabsChannels } from "../../instrumentation/plugins/elevenlabs-channels";

export const elevenLabsConfigs: InstrumentationConfig[] = [
  ...(
    [
      "convert",
      "stream",
      "convertWithTimestamps",
      "streamWithTimestamps",
    ] as const
  ).map((methodName) => ({
    channelName: elevenLabsChannels[methodName].channelName,
    module: {
      name: "@elevenlabs/elevenlabs-js",
      versionRange: ">=2.67.0 <3.0.0",
      filePath: "api/resources/textToSpeech/client/Client.js",
    },
    functionQuery: {
      className: "TextToSpeechClient",
      methodName,
      kind: "Async" as const,
    },
  })),
  {
    channelName: elevenLabsChannels.transcribe.channelName,
    module: {
      name: "@elevenlabs/elevenlabs-js",
      versionRange: ">=2.67.0 <3.0.0",
      filePath: "api/resources/speechToText/client/Client.js",
    },
    functionQuery: {
      className: "SpeechToTextClient",
      methodName: "convert",
      kind: "Async",
    },
  },
];
