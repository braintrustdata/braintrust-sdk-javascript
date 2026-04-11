import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { googleADKChannels } from "../../instrumentation/plugins/google-adk-channels";

/**
 * Instrumentation configurations for the Google ADK (@google/adk).
 *
 * Runner.runAsync and BaseAgent.runAsync are async generators (`async *`).
 * They synchronously return an AsyncGenerator object, so we use kind "Sync"
 * paired with "sync-stream" channels — the same pattern used by the
 * Claude Agent SDK's `query` function.
 *
 * FunctionTool.runAsync is a regular async method (returns Promise<unknown>)
 * and uses kind "Async".
 */
export const googleADKConfigs: InstrumentationConfig[] = [
  // --- Runner.runAsync --- async generator, kind "Sync" + sync-stream channel

  // Runner.runAsync — ESM individual module file
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/esm/runner/runner.js",
    },
    functionQuery: {
      className: "Runner",
      methodName: "runAsync",
      kind: "Sync",
    },
  },

  // Runner.runAsync — CJS bundled index
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      className: "Runner",
      methodName: "runAsync",
      kind: "Sync",
    },
  },

  // Runner.runAsync — ESM bundled index
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      className: "Runner",
      methodName: "runAsync",
      kind: "Sync",
    },
  },

  // --- BaseAgent.runAsync --- async generator, kind "Sync" + sync-stream channel

  // BaseAgent.runAsync — ESM individual module file
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/esm/agents/base_agent.js",
    },
    functionQuery: {
      className: "BaseAgent",
      methodName: "runAsync",
      kind: "Sync",
    },
  },

  // BaseAgent.runAsync — CJS bundled index
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      className: "BaseAgent",
      methodName: "runAsync",
      kind: "Sync",
    },
  },

  // BaseAgent.runAsync — ESM bundled index
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      className: "BaseAgent",
      methodName: "runAsync",
      kind: "Sync",
    },
  },

  // --- FunctionTool.runAsync --- regular async, kind "Async"

  // FunctionTool.runAsync — ESM individual module file
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/esm/tools/function_tool.js",
    },
    functionQuery: {
      className: "FunctionTool",
      methodName: "runAsync",
      kind: "Async",
    },
  },

  // FunctionTool.runAsync — CJS bundled index
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      className: "FunctionTool",
      methodName: "runAsync",
      kind: "Async",
    },
  },

  // FunctionTool.runAsync — ESM bundled index
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: ">=0.1.0",
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      className: "FunctionTool",
      methodName: "runAsync",
      kind: "Async",
    },
  },
];
