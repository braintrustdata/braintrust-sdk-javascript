import type { InstrumentationConfig } from "../orchestrion-js";
import {
  genkitChannels,
  genkitCoreChannels,
} from "../../instrumentation/providers/genkit-interceptors";

const genkitVersionRange = ">=1.0.0 <2.0.0";

/**
 * Instrumentation configurations for Genkit's JavaScript SDK.
 *
 * Genkit's public instance methods live on the GenkitAI base class in
 * @genkit-ai/ai. The top-level `genkit` package subclasses that class, so
 * targeting these methods instruments regular `genkit({ ... })` instances.
 */
export const genkitConfigs: InstrumentationConfig[] = [
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
    },
  },
];
