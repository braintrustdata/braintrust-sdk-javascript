import { describe, expect, it } from "vitest";
import { aiSDKChannels } from "../../instrumentation/plugins/ai-sdk-channels";
import { aiSDKConfigs } from "./ai-sdk";

function findConfigsByFunctionName(functionName: string) {
  return aiSDKConfigs.filter((config) => {
    if (!("functionQuery" in config)) {
      return false;
    }
    const query = config.functionQuery as { functionName?: unknown };
    return query.functionName === functionName;
  });
}

describe("aiSDKConfigs", () => {
  it("defines embed channels", () => {
    expect(aiSDKChannels.embed.channelName).toBe("embed");
    expect(aiSDKChannels.embedMany.channelName).toBe("embedMany");
  });

  it("instruments embed() in both ESM and CJS entrypoints", () => {
    const embedConfigs = findConfigsByFunctionName("embed");

    expect(embedConfigs).toHaveLength(2);
    expect(embedConfigs.map((config) => config.channelName)).toEqual([
      aiSDKChannels.embed.channelName,
      aiSDKChannels.embed.channelName,
    ]);
    expect(embedConfigs.map((config) => config.module.filePath).sort()).toEqual(
      ["dist/index.js", "dist/index.mjs"],
    );
  });

  it("instruments embedMany() in both ESM and CJS entrypoints", () => {
    const embedManyConfigs = findConfigsByFunctionName("embedMany");

    expect(embedManyConfigs).toHaveLength(2);
    expect(embedManyConfigs.map((config) => config.channelName)).toEqual([
      aiSDKChannels.embedMany.channelName,
      aiSDKChannels.embedMany.channelName,
    ]);
    expect(
      embedManyConfigs.map((config) => config.module.filePath).sort(),
    ).toEqual(["dist/index.js", "dist/index.mjs"]);
  });
});
