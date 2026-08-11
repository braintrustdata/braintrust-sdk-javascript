import { describe, expect, it } from "vitest";
import { readDisabledInstrumentationEnvConfig } from "../../instrumentation/config";
import { getDefaultInstrumentationConfigs } from "./all";
import { stagehandConfigs } from "./stagehand";

const stagehandChannelNames = [
  "Stagehand.act",
  "Stagehand.extract",
  "Stagehand.observe",
  "Stagehand.agent",
] as const;

describe("stagehandConfigs", () => {
  it("targets the v3.0 bundle and v3.1+ ESM/CJS class files", () => {
    expect(stagehandConfigs).toHaveLength(12);
    expect(stagehandConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelName: "Stagehand.act",
          module: {
            name: "@browserbasehq/stagehand",
            versionRange: ">=3.0.0 <3.1.0",
            filePath: "dist/index.js",
          },
          functionQuery: {
            className: "_V3",
            methodName: "act",
            kind: "Async",
          },
        }),
        expect.objectContaining({
          channelName: "Stagehand.agent",
          module: expect.objectContaining({
            versionRange: ">=3.1.0 <4.0.0",
            filePath: "dist/esm/lib/v3/v3.js",
          }),
          functionQuery: {
            className: "V3",
            methodName: "agent",
            kind: "Sync",
          },
        }),
        expect.objectContaining({
          module: expect.objectContaining({
            filePath: "dist/cjs/lib/v3/v3.js",
          }),
        }),
      ]),
    );
  });

  it("is enabled by default and supports every disable alias", () => {
    expect(
      getDefaultInstrumentationConfigs().some((config) =>
        stagehandChannelNames.includes(config.channelName as never),
      ),
    ).toBe(true);

    for (const alias of [
      "stagehand",
      "browserbase-stagehand",
      "@browserbasehq/stagehand",
    ]) {
      const disabledConfig =
        readDisabledInstrumentationEnvConfig(alias).integrations;
      expect(disabledConfig).toMatchObject({ stagehand: false });
      expect(
        getDefaultInstrumentationConfigs({
          disabledIntegrationConfig: disabledConfig,
        }).some((config) =>
          stagehandChannelNames.includes(config.channelName as never),
        ),
      ).toBe(false);
    }
  });
});
