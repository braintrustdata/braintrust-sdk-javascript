import { describe, expect, it } from "vitest";
import { readDisabledInstrumentationEnvConfig } from "../../instrumentation/config";
import { getDefaultInstrumentationConfigs } from "./all";
import { strandsAgentSDKConfigs } from "./strands-agent-sdk";

const strandsChannelNames = [
  "Agent.stream",
  "Graph.stream",
  "Swarm.stream",
] as const;

describe("strandsAgentSDKConfigs", () => {
  it("targets the Strands Agent SDK stream entrypoints", () => {
    expect(strandsAgentSDKConfigs).toHaveLength(3);
    expect(strandsAgentSDKConfigs.map((config) => config.channelName)).toEqual(
      strandsChannelNames,
    );
    expect(strandsAgentSDKConfigs).toEqual([
      expect.objectContaining({
        module: {
          name: "@strands-agents/sdk",
          versionRange: ">=1.0.0 <2.0.0",
          filePath: "dist/src/agent/agent.js",
        },
        functionQuery: {
          className: "Agent",
          methodName: "stream",
          kind: "Sync",
        },
      }),
      expect.objectContaining({
        module: expect.objectContaining({
          filePath: "dist/src/multiagent/graph.js",
        }),
        functionQuery: expect.objectContaining({
          className: "Graph",
          methodName: "stream",
        }),
      }),
      expect.objectContaining({
        module: expect.objectContaining({
          filePath: "dist/src/multiagent/swarm.js",
        }),
        functionQuery: expect.objectContaining({
          className: "Swarm",
          methodName: "stream",
        }),
      }),
    ]);
  });

  it("is included by default and disabled by Strands Agent SDK integration keys", () => {
    expect(
      getDefaultInstrumentationConfigs().some((config) =>
        strandsChannelNames.includes(config.channelName as never),
      ),
    ).toBe(true);

    for (const alias of [
      "strandsAgentSDK",
      "strandsagentsdk",
      "strands-agent-sdk",
      "@strands-agents/sdk",
    ]) {
      const disabledConfig =
        readDisabledInstrumentationEnvConfig(alias).integrations;

      expect(disabledConfig).toMatchObject({ strandsAgentSDK: false });
      expect(
        getDefaultInstrumentationConfigs({
          disabledIntegrationConfig: disabledConfig,
        }).some((config) =>
          strandsChannelNames.includes(config.channelName as never),
        ),
      ).toBe(false);
    }
  });
});
