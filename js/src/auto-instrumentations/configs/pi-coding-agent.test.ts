import { describe, expect, it } from "vitest";
import { readDisabledInstrumentationEnvConfig } from "../../instrumentation/config";
import { getDefaultInstrumentationConfigs } from "./all";

const piCodingAgentChannelName = "AgentSession.prompt";

describe("piCodingAgentConfigs", () => {
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
