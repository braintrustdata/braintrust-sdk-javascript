import type { InstrumentationConfig } from "../orchestrion-js";
import { aiSDKChannels } from "../../instrumentation/plugins/ai-sdk-channels";

/**
 * Orchestrion configurations for the Vercel AI SDK.
 *
 * These configs define which functions to instrument and what channel
 * to emit events on. They are used by orchestrion-js to perform AST
 * transformation at build-time or load-time.
 *
 * NOTE: Channel names should NOT include the braintrust: prefix. The code-transformer
 * will prepend "orchestrion:ai-sdk:" to these names, resulting in final channel names like:
 * "orchestrion:ai-sdk:generateText"
 */
export const aiSDKOrchestrionConfigs: InstrumentationConfig[] = [
  // generateText - async function
  {
    channelName: aiSDKChannels.generateText.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "generateText",
      kind: "Async",
    },
  },
  {
    channelName: aiSDKChannels.generateText.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "generateText",
      kind: "Async",
    },
  },

  // streamText - async function (v3 only, before the sync refactor in v4)
  {
    channelName: aiSDKChannels.streamText.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <4.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "streamText",
      kind: "Async",
    },
  },

  // streamText - sync function returning stream (v4+)
  {
    channelName: aiSDKChannels.streamTextSync.channelName,
    module: {
      name: "ai",
      versionRange: ">=4.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "streamText",
      kind: "Sync",
    },
  },
  {
    channelName: aiSDKChannels.streamText.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <4.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "streamText",
      kind: "Async",
    },
  },
  {
    channelName: aiSDKChannels.streamTextSync.channelName,
    module: {
      name: "ai",
      versionRange: ">=4.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "streamText",
      kind: "Sync",
    },
  },

  // generateObject - async function
  {
    channelName: aiSDKChannels.generateObject.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "generateObject",
      kind: "Async",
    },
  },
  {
    channelName: aiSDKChannels.generateObject.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "generateObject",
      kind: "Async",
    },
  },

  // embed - async function
  {
    channelName: aiSDKChannels.embed.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "embed",
      kind: "Async",
    },
  },
  {
    channelName: aiSDKChannels.embed.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "embed",
      kind: "Async",
    },
  },

  // embedMany - async function
  {
    channelName: aiSDKChannels.embedMany.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "embedMany",
      kind: "Async",
    },
  },
  {
    channelName: aiSDKChannels.embedMany.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "embedMany",
      kind: "Async",
    },
  },

  // rerank - async function
  {
    channelName: aiSDKChannels.rerank.channelName,
    module: {
      name: "ai",
      versionRange: ">=5.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "rerank",
      kind: "Async",
    },
  },
  {
    channelName: aiSDKChannels.rerank.channelName,
    module: {
      name: "ai",
      versionRange: ">=5.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "rerank",
      kind: "Async",
    },
  },

  // AI SDK v7 exposes its telemetry lifecycle through a dispatcher created for
  // each operation. We patch that dispatcher in the plugin instead of rewriting
  // the module to call registerTelemetry().
  {
    channelName: aiSDKChannels.v7CreateTelemetryDispatcher.channelName,
    module: {
      name: "ai",
      versionRange: ">=7.0.0-0 <8.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "createTelemetryDispatcher",
      kind: "Sync",
    },
  },
  {
    channelName: aiSDKChannels.v7CreateTelemetryDispatcher.channelName,
    module: {
      name: "ai",
      versionRange: ">=7.0.0-0 <8.0.0",
      filePath: "dist/internal/index.js",
    },
    functionQuery: {
      functionName: "createTelemetryDispatcher",
      kind: "Sync",
    },
  },

  // streamObject - async function (v3 only, before the sync refactor in v4)
  {
    channelName: aiSDKChannels.streamObject.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <4.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "streamObject",
      kind: "Async",
    },
  },

  // streamObject - sync function returning stream (v4+)
  {
    channelName: aiSDKChannels.streamObjectSync.channelName,
    module: {
      name: "ai",
      versionRange: ">=4.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      functionName: "streamObject",
      kind: "Sync",
    },
  },
  {
    channelName: aiSDKChannels.streamObject.channelName,
    module: {
      name: "ai",
      versionRange: ">=3.0.0 <4.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "streamObject",
      kind: "Async",
    },
  },
  {
    channelName: aiSDKChannels.streamObjectSync.channelName,
    module: {
      name: "ai",
      versionRange: ">=4.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "streamObject",
      kind: "Sync",
    },
  },

  // Agent.generate - async method (v5 only)
  // The compiled AI SDK bundle emits this as an anonymous class method, so we
  // target the first async `generate` method in the file instead of a class name.
  {
    channelName: aiSDKChannels.agentGenerate.channelName,
    module: {
      name: "ai",
      versionRange: ">=5.0.0 <6.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      methodName: "generate",
      kind: "Async",
      index: 0,
    },
  },
  {
    channelName: aiSDKChannels.agentGenerate.channelName,
    module: {
      name: "ai",
      versionRange: ">=5.0.0 <6.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      methodName: "generate",
      kind: "Async",
      index: 0,
    },
  },

  // Agent.stream - sync method (v5 only)
  // The compiled AI SDK bundle emits this as an anonymous class method, so we
  // target the first sync `stream` method in the file instead of a class name.
  {
    channelName: aiSDKChannels.agentStreamSync.channelName,
    module: {
      name: "ai",
      versionRange: ">=5.0.0 <6.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      methodName: "stream",
      kind: "Sync",
      index: 0,
    },
  },
  {
    channelName: aiSDKChannels.agentStreamSync.channelName,
    module: {
      name: "ai",
      versionRange: ">=5.0.0 <6.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      methodName: "stream",
      kind: "Sync",
      index: 0,
    },
  },

  // ToolLoopAgent.generate - async method (v6 only, Experimental_Agent is an alias)
  // The compiled AI SDK bundle emits this as an anonymous class method, so we
  // target the first async `generate` method in the file instead of a class name.
  {
    channelName: aiSDKChannels.toolLoopAgentGenerate.channelName,
    module: {
      name: "ai",
      versionRange: ">=6.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      methodName: "generate",
      kind: "Async",
      index: 0,
    },
  },
  {
    channelName: aiSDKChannels.toolLoopAgentGenerate.channelName,
    module: {
      name: "ai",
      versionRange: ">=6.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      methodName: "generate",
      kind: "Async",
      index: 0,
    },
  },

  // ToolLoopAgent.stream - async method (v6 only, Experimental_Agent is an alias)
  // The compiled AI SDK bundle emits this as an anonymous class method, so we
  // target the first async `stream` method in the file instead of a class name.
  {
    channelName: aiSDKChannels.toolLoopAgentStream.channelName,
    module: {
      name: "ai",
      versionRange: ">=6.0.0 <7.0.0",
      filePath: "dist/index.mjs",
    },
    functionQuery: {
      methodName: "stream",
      kind: "Async",
      index: 0,
    },
  },
  {
    channelName: aiSDKChannels.toolLoopAgentStream.channelName,
    module: {
      name: "ai",
      versionRange: ">=6.0.0 <7.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: {
      methodName: "stream",
      kind: "Async",
      index: 0,
    },
  },
];
