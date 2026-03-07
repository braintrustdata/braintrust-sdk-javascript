import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { aiSDKChannels } from "../../instrumentation/plugins/ai-sdk-channels";

/**
 * Instrumentation configurations for the Vercel AI SDK.
 *
 * These configs define which functions to instrument and what channel
 * to emit events on. They are used by orchestrion-js to perform AST
 * transformation at build-time or load-time.
 *
 * NOTE: Channel names should NOT include the braintrust: prefix. The code-transformer
 * will prepend "orchestrion:ai-sdk:" to these names, resulting in final channel names like:
 * "orchestrion:ai-sdk:generateText"
 */
export const aiSDKConfigs: InstrumentationConfig[] = [
  // generateText - async function
  {
    channelName: aiSDKChannels.generateText.name,
    module: {
      name: "ai",
      versionRange: ">=3.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "generateText",
      kind: "Async",
    },
  },

  // streamText - async function
  {
    channelName: aiSDKChannels.streamText.name,
    module: {
      name: "ai",
      versionRange: ">=3.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "streamText",
      kind: "Async",
    },
  },

  // generateObject - async function
  {
    channelName: aiSDKChannels.generateObject.name,
    module: {
      name: "ai",
      versionRange: ">=3.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "generateObject",
      kind: "Async",
    },
  },

  // streamObject - async function
  {
    channelName: aiSDKChannels.streamObject.name,
    module: {
      name: "ai",
      versionRange: ">=3.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "streamObject",
      kind: "Async",
    },
  },

  // Agent.generate - async method (v3-v5 only, Agent structure changed in v6)
  {
    channelName: aiSDKChannels.agentGenerate.name,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <6.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      className: "Agent",
      methodName: "generate",
      kind: "Async",
    },
  },

  // Agent.stream - async method (v3-v5 only, Agent structure changed in v6)
  {
    channelName: aiSDKChannels.agentStream.name,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <6.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      className: "Agent",
      methodName: "stream",
      kind: "Async",
    },
  },
];
