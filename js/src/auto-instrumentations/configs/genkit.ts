import type { InstrumentationConfig } from "../orchestrion-js";
import {
  genkitChannels,
  genkitCoreChannels,
} from "../../instrumentation/plugins/genkit-channels";

const genkitVersionRange = ">=1.0.0 <2.0.0";

/**
 * Orchestrion configurations for Genkit's JavaScript SDK.
 *
 * Genkit's public instance methods live on the GenkitAI base class in
 * @genkit-ai/ai. The top-level `genkit` package subclasses that class, so
 * targeting these methods instruments regular `genkit({ ... })` instances.
 */
export const genkitOrchestrionConfigs: InstrumentationConfig[] = [
  {
    channelName: genkitChannels.generate.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.mjs",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "generate",
      kind: "Async",
    },
  },
  {
    channelName: genkitChannels.generate.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.js",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "generate",
      kind: "Async",
    },
  },
  {
    channelName: genkitChannels.generateStream.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.mjs",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "generateStream",
      kind: "Sync",
    },
  },
  {
    channelName: genkitChannels.generateStream.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.js",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "generateStream",
      kind: "Sync",
    },
  },
  {
    channelName: genkitChannels.embed.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.mjs",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "embed",
      kind: "Async",
    },
  },
  {
    channelName: genkitChannels.embed.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.js",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "embed",
      kind: "Async",
    },
  },
  {
    channelName: genkitChannels.embedMany.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.mjs",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "embedMany",
      kind: "Async",
    },
  },
  {
    channelName: genkitChannels.embedMany.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.js",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "embedMany",
      kind: "Async",
    },
  },
  {
    channelName: genkitChannels.actionRun.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.mjs",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "run",
      kind: "Async",
    },
  },
  {
    channelName: genkitChannels.actionRun.channelName,
    module: {
      name: "@genkit-ai/ai",
      versionRange: genkitVersionRange,
      filePath: "lib/genkit-ai.js",
    },
    functionQuery: {
      className: "GenkitAI",
      methodName: "run",
      kind: "Async",
    },
  },
  {
    channelName: genkitCoreChannels.actionSpan.channelName,
    module: {
      name: "@genkit-ai/core",
      versionRange: genkitVersionRange,
      filePath: "lib/tracing/instrumentation.mjs",
    },
    functionQuery: {
      functionName: "runInNewSpan",
      kind: "Async",
    },
  },
  {
    channelName: genkitCoreChannels.actionSpan.channelName,
    module: {
      name: "@genkit-ai/core",
      versionRange: genkitVersionRange,
      filePath: "lib/tracing/instrumentation.js",
    },
    functionQuery: {
      functionName: "runInNewSpan",
      kind: "Async",
    },
  },
];
