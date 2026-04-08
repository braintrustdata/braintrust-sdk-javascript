import { describe, expect, it } from "vitest";
import { openRouterAgentConfigs } from "./openrouter-agent";
import { openRouterAgentChannels } from "../../instrumentation/plugins/openrouter-agent-channels";

describe("openRouterAgentConfigs", () => {
  it("registers auto-instrumentation for @openrouter/agent callModel()", () => {
    expect(openRouterAgentConfigs).toContainEqual({
      channelName: openRouterAgentChannels.callModel.channelName,
      module: {
        name: "@openrouter/agent",
        versionRange: ">=0.1.2",
        filePath: "esm/inner-loop/call-model.js",
      },
      functionQuery: {
        functionName: "callModel",
        kind: "Sync",
      },
    });
  });
});
