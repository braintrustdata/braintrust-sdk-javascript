import type { InstrumentationConfig } from "../orchestrion-js";
import { ollamaChannels } from "../../instrumentation/providers/ollama-channels";

const methods = [
  ["chat", ollamaChannels.chat.channelName],
  ["generate", ollamaChannels.generate.channelName],
  ["embed", ollamaChannels.embed.channelName],
] as const;

// Ollama's Node entry points in dist/index.{mjs,cjs} subclass the Ollama class
// exported here. These methods are defined on that shared base class, so
// instrumenting these files covers both the Node and browser package exports.
const implementationFiles = ["dist/browser.mjs", "dist/browser.cjs"] as const;

export const ollamaConfigs: InstrumentationConfig[] = [
  ...implementationFiles.flatMap((filePath) =>
    methods.map(([methodName, channelName]) => ({
      channelName,
      module: {
        name: "ollama",
        versionRange: ">=0.6.0 <0.7.0",
        filePath,
      },
      functionQuery: {
        className: "Ollama",
        methodName,
        kind: "Async" as const,
      },
    })),
  ),
];
