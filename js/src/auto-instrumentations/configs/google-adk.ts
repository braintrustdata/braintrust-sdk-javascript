import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { googleADKChannels } from "../../instrumentation/plugins/google-adk-channels";

const googleADKVersionRange = ">=0.1.0";
const googleADKBundledIndexVersionRange = ">=0.6.1 <0.7.0";

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
      versionRange: googleADKVersionRange,
      filePath: "dist/esm/runner/runner.js",
    },
    functionQuery: {
      className: "Runner",
      methodName: "runAsync",
      kind: "Sync",
    },
  },

  // Runner.runAsync — bundled CJS/ESM indexes
  // The bundled entrypoints minify class names, so target the 11th sync
  // `runAsync` method in file order rather than a class name. This mapping is
  // only validated against the current 0.6.x bundle layout, so keep the range
  // tight until we verify newer bundled outputs.
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexVersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      kind: "Sync",
      index: 10,
    },
  },
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexVersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      kind: "Sync",
      index: 10,
    },
  },

  // --- BaseAgent.runAsync --- async generator, kind "Sync" + sync-stream channel

  // BaseAgent.runAsync — ESM individual module file
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKVersionRange,
      filePath: "dist/esm/agents/base_agent.js",
    },
    functionQuery: {
      className: "BaseAgent",
      methodName: "runAsync",
      kind: "Sync",
    },
  },

  // BaseAgent.runAsync — bundled CJS/ESM indexes
  // The bundled entrypoints minify class names, so target the first sync
  // `runAsync` method in file order rather than a class name. This mapping is
  // only validated against the current 0.6.x bundle layout, so keep the range
  // tight until we verify newer bundled outputs.
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexVersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      kind: "Sync",
      index: 0,
    },
  },
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexVersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      kind: "Sync",
      index: 0,
    },
  },

  // --- FunctionTool.runAsync --- regular async, kind "Async"

  // FunctionTool.runAsync — ESM individual module file
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKVersionRange,
      filePath: "dist/esm/tools/function_tool.js",
    },
    functionQuery: {
      className: "FunctionTool",
      methodName: "runAsync",
      kind: "Async",
    },
  },

  // FunctionTool.runAsync — bundled CJS/ESM indexes
  // The bundled entrypoints minify class names, so target the first async
  // `runAsync` method in file order rather than a class name. This mapping is
  // only validated against the current 0.6.x bundle layout, so keep the range
  // tight until we verify newer bundled outputs.
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexVersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      kind: "Async",
      index: 0,
    },
  },
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexVersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      kind: "Async",
      index: 0,
    },
  },
];
