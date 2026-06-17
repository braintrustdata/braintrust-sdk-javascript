import { describe, expect, it } from "vitest";
import { readDisabledInstrumentationEnvConfig } from "../../instrumentation/config";
import { getDefaultInstrumentationConfigs } from "./all";
import { piCodingAgentConfigs } from "./pi-coding-agent";

const piCodingAgentChannelName = "AgentSession.prompt";

describe("piCodingAgentConfigs", () => {
  it("targets the Pi Coding Agent library AgentSession.prompt entrypoint", () => {
    expect(piCodingAgentConfigs).toHaveLength(1);
    expect(piCodingAgentConfigs[0]).toMatchObject({
      channelName: piCodingAgentChannelName,
      module: {
        name: "@earendil-works/pi-coding-agent",
        versionRange: ">=0.79.0 <0.80.0",
        filePath: "dist/core/agent-session.js",
      },
      functionQuery: {
        className: "AgentSession",
        methodName: "prompt",
        kind: "Async",
      },
    });
    expect(piCodingAgentConfigs[0].module.filePath).not.toContain("cli");
  });

  it("is included by default and disabled by Pi Coding Agent env aliases", () => {
    expect(
      getDefaultInstrumentationConfigs().some(
        (config) => config.channelName === piCodingAgentChannelName,
      ),
    ).toBe(true);

    for (const alias of [
      "pi-coding-agent",
      "pi-coding-agent-sdk",
      "picodingagent",
      "picodingagentsdk",
      "@earendil-works/pi-coding-agent",
    ]) {
      const disabledConfig =
        readDisabledInstrumentationEnvConfig(alias).integrations;

      expect(disabledConfig).toMatchObject({ piCodingAgent: false });
      expect(
        getDefaultInstrumentationConfigs({
          disabledIntegrationConfig: disabledConfig,
        }).some((config) => config.channelName === piCodingAgentChannelName),
      ).toBe(false);
    }
  });
});
