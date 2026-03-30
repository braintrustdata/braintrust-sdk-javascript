import { describe, expect, it } from "vitest";
import { openRouterConfigs } from "./openrouter";
import { openRouterChannels } from "../../instrumentation/plugins/openrouter-channels";

describe("openRouterConfigs", () => {
  it("registers auto-instrumentation for OpenRouter.callModel", () => {
    expect(openRouterConfigs).toContainEqual({
      channelName: openRouterChannels.callModel.channelName,
      module: {
        name: "@openrouter/sdk",
        versionRange: ">=0.9.11 <1.0.0",
        filePath: "esm/sdk/sdk.js",
      },
      functionQuery: {
        className: "OpenRouter",
        methodName: "callModel",
        kind: "Sync",
      },
    });
  });
});
