import type { InstrumentationConfig } from "../orchestrion-js";
import {
  aiSDKChannels,
  codeModeChannels,
  harnessAgentChannels,
} from "../../instrumentation/providers/ai-sdk-interceptors";

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
  // Think needs the synchronous invocation boundary to keep its task open
  // until v7's asynchronous telemetry callbacks take over.
  {
    channelName: aiSDKChannels.streamTextV7.channelName,
    module: {
      name: "ai",
      versionRange: ">=7.0.0 <8.0.0",
      filePath: "dist/index.js",
    },
    functionQuery: { functionName: "streamText" },
  },
  {
    channelName: codeModeChannels.run.channelName,
    module: {
      name: "@ai-sdk/code-mode",
      versionRange: ">=1.0.100 <2.0.0",
      filePath: "dist/run-code-mode.js",
    },
    functionQuery: { functionName: "runCodeMode" },
  },
  // Older evaluation releases have no telemetry callbacks. Newer versions use
  // the telemetry dispatcher below, including the renamed decision API.
  {
    channelName: aiSDKChannels.evaluate.channelName,
    module: {
      name: "ai",
      versionRange: ">=7.0.103 <7.0.111",
      filePath: "dist/index.js",
    },
    functionQuery: {
      functionName: "experimental_evaluate",
      isExportAlias: true,
    },
  },
  // HarnessAgent turn methods are published only from the package's ESM
  // `./agent` entrypoint. Target the class binding so similarly named getters
  // on stream result classes are not mistaken for agent turn methods.
  ...[
    ["createSession", harnessAgentChannels.createSession.channelName],
    ["generate", harnessAgentChannels.generate.channelName],
    ["stream", harnessAgentChannels.stream.channelName],
    ["continueGenerate", harnessAgentChannels.continueGenerate.channelName],
    ["continueStream", harnessAgentChannels.continueStream.channelName],
  ].map(([methodName, channelName]) => ({
    channelName,
    module: {
      name: "@ai-sdk/harness",
      versionRange: ">=1.0.0 <2.0.0",
      filePath: "dist/agent/index.js",
    },
    functionQuery: {
      className: "HarnessAgent",
      methodName,
      index: 0,
    },
  })),

  // Async generation and embedding functions supported by AI SDK v4-v6.
  ...[
    ["generateText", aiSDKChannels.generateText.channelName],
    ["generateObject", aiSDKChannels.generateObject.channelName],
    ["embed", aiSDKChannels.embed.channelName],
    ["embedMany", aiSDKChannels.embedMany.channelName],
  ].flatMap(([functionName, channelName]) =>
    ["dist/index.mjs", "dist/index.js"].map((filePath) => ({
      channelName,
      module: {
        name: "ai",
        versionRange: ">=4.0.0 <7.0.0",
        filePath,
      },
      functionQuery: {
        functionName,
      },
    })),
  ),

  // generateImage - stable in v6+, experimental alias in v5
  ...[
    {
      functionName: "generateImage",
      versionRange: ">=6.0.0 <8.0.0",
      isExportAlias: false,
    },
    {
      functionName: "experimental_generateImage",
      versionRange: ">=5.0.0 <6.0.0",
      isExportAlias: true,
    },
  ].flatMap(({ functionName, versionRange, isExportAlias }) =>
    ["dist/index.mjs", "dist/index.js"].map((filePath) => ({
      channelName: aiSDKChannels.generateImage.channelName,
      module: {
        name: "ai",
        versionRange,
        filePath,
      },
      functionQuery: {
        functionName,
        ...(isExportAlias ? { isExportAlias } : {}),
      },
    })),
  ),

  // Streaming functions are synchronous starting in AI SDK v4.
  ...[
    ["streamText", aiSDKChannels.streamTextSync.channelName],
    ["streamObject", aiSDKChannels.streamObjectSync.channelName],
  ].flatMap(([functionName, channelName]) =>
    ["dist/index.mjs", "dist/index.js"].map((filePath) => ({
      channelName,
      module: {
        name: "ai",
        versionRange: ">=4.0.0 <7.0.0",
        filePath,
      },
      functionQuery: {
        functionName,
      },
    })),
  ),

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
    },
  },

  // AI SDK v7 exposes its telemetry lifecycle through a dispatcher created for
  // each operation. We patch that dispatcher in the consumer instead of rewriting
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
      index: 0,
    },
  },
];
