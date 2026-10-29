import type { InstrumentationConfig } from "../orchestrion-js";
import { googleADKChannels } from "../../instrumentation/providers/google-adk-interceptors";

const googleADKVersionRange = ">=0.1.0";
const googleADKBundledIndexV06VersionRange = ">=0.6.1 <0.7.0";
const googleADKBundledIndexV1VersionRange = ">=1.0.0 <2.0.0";

/**
 * Instrumentation configurations for the Google ADK (@google/adk).
 *
 * Runner.runAsync and BaseAgent.runAsync synchronously return async generators.
 * FunctionTool.runAsync returns a Promise; the plugin handles these result
 * shapes independently of the transformer.
 */
export const googleADKConfigs: InstrumentationConfig[] = [
  // --- Runner.runAsync --- async generator

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
    },
  },

  // Runner.runAsync — bundled CJS/ESM indexes
  // The bundled entrypoints minify class names, so target the 12th sync
  // `runAsync` method in file order rather than a class name. This mapping is
  // only validated against the current 0.6.x bundle layout, so keep the range
  // tight until we verify newer bundled outputs.
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV06VersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 11,
    },
  },
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV06VersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 11,
    },
  },
  // The 1.x bundled entrypoints still inline the runtime into index.js, but
  // the minified method order changed. These indices are verified against 1.0.0.
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV1VersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 12,
    },
  },
  {
    channelName: googleADKChannels.runnerRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV1VersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 12,
    },
  },

  // --- BaseAgent.runAsync --- async generator

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
      versionRange: googleADKBundledIndexV06VersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 0,
    },
  },
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV06VersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 0,
    },
  },
  // The 1.x bundled entrypoints keep BaseAgent.runAsync as the first bundled
  // async-generator runAsync method in file order.
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV1VersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 0,
    },
  },
  {
    channelName: googleADKChannels.agentRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV1VersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 0,
    },
  },

  // --- FunctionTool.runAsync --- regular async

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
      versionRange: googleADKBundledIndexV06VersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 1,
    },
  },
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV06VersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 1,
    },
  },
  // The 1.x bundle moves FunctionTool.runAsync behind one helper method.
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV1VersionRange,
      filePath: "dist/cjs/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 1,
    },
  },
  {
    channelName: googleADKChannels.toolRunAsync.channelName,
    module: {
      name: "@google/adk",
      versionRange: googleADKBundledIndexV1VersionRange,
      filePath: "dist/esm/index.js",
    },
    functionQuery: {
      methodName: "runAsync",
      index: 1,
    },
  },
];
