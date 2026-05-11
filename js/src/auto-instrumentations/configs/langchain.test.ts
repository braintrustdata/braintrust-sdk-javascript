import { describe, expect, it } from "vitest";
import { langChainChannels } from "../../instrumentation/plugins/langchain-channels";
import { langchainConfigs } from "./langchain";

describe("langchain auto-instrumentation configs", () => {
  it("targets CallbackManager configure methods in @langchain/core", () => {
    expect(langchainConfigs).toEqual([
      {
        channelName: langChainChannels.configure.channelName,
        module: {
          name: "@langchain/core",
          versionRange: ">=0.3.42",
          filePath: "dist/callbacks/manager.js",
        },
        functionQuery: {
          className: "CallbackManager",
          methodName: "configure",
          kind: "Sync",
        },
      },
      {
        channelName: langChainChannels.configureSync.channelName,
        module: {
          name: "@langchain/core",
          versionRange: ">=0.3.42",
          filePath: "dist/callbacks/manager.js",
        },
        functionQuery: {
          className: "CallbackManager",
          methodName: "_configureSync",
          kind: "Sync",
        },
      },
    ]);
  });
});
