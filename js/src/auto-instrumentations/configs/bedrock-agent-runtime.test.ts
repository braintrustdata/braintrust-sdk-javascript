import { describe, expect, it } from "vitest";
import {
  readDisabledInstrumentationEnvConfig,
  type InstrumentationIntegrationsConfig,
} from "../../instrumentation/config";
import { getDefaultInstrumentationConfigs } from "./all";
import { bedrockAgentRuntimeConfigs } from "./bedrock-agent-runtime";
import { bedrockRuntimeConfigs } from "./bedrock-runtime";

const smithyClientSendChannel = "client.send";

function includesSmithyClientSend(
  disabledIntegrationConfig?: InstrumentationIntegrationsConfig,
): boolean {
  return getDefaultInstrumentationConfigs({
    disabledIntegrationConfig,
  }).some(
    (config) =>
      config.channelName === smithyClientSendChannel &&
      config.module.name === "@smithy/core",
  );
}

describe("bedrockAgentRuntimeConfigs", () => {
  it("reuses the Smithy Client.send transformations", () => {
    expect(bedrockAgentRuntimeConfigs).toBe(bedrockRuntimeConfigs);
    expect(
      bedrockAgentRuntimeConfigs.some(
        (config) =>
          config.channelName === smithyClientSendChannel &&
          config.module.name === "@smithy/core",
      ),
    ).toBe(true);
  });

  it("keeps shared transformations while either Bedrock integration is enabled", () => {
    expect(
      includesSmithyClientSend({
        awsBedrockAgentRuntime: false,
        awsBedrockRuntime: true,
      }),
    ).toBe(true);
    expect(
      includesSmithyClientSend({
        awsBedrockAgentRuntime: true,
        awsBedrockRuntime: false,
      }),
    ).toBe(true);
    expect(
      includesSmithyClientSend({
        awsBedrockAgentRuntime: false,
        awsBedrockRuntime: false,
      }),
    ).toBe(false);
  });

  it("supports Agent Runtime disable aliases", () => {
    for (const alias of [
      "aws-bedrock-agent-runtime",
      "awsbedrockagentruntime",
      "@aws-sdk/client-bedrock-agent-runtime",
    ]) {
      expect(readDisabledInstrumentationEnvConfig(alias).integrations).toEqual({
        awsBedrockAgentRuntime: false,
      });
    }
  });
});
