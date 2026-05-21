import { describe, expect, it } from "vitest";
import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { aiSDKConfigs } from "./ai-sdk";
import { getDefaultInstrumentationConfigs } from "./all";
import { googleADKConfigs } from "./google-adk";
import { openaiConfigs } from "./openai";
import { openAICodexConfigs } from "./openai-codex";

describe("getDefaultInstrumentationConfigs", () => {
  it("includes config families that used to drift between entrypoints", () => {
    const configs = getDefaultInstrumentationConfigs();

    expect(configs).toContain(openAICodexConfigs[0]);
    expect(configs).toContain(googleADKConfigs[0]);
  });

  it("appends custom instrumentations after the defaults", () => {
    const customConfig: InstrumentationConfig = {
      ...openaiConfigs[0],
      channelName: "custom.test",
    };

    const configs = getDefaultInstrumentationConfigs({
      additionalInstrumentations: [customConfig],
    });

    expect(configs[configs.length - 1]).toBe(customConfig);
  });

  it("filters disabled integration aliases for the load-time hook", () => {
    const configs = getDefaultInstrumentationConfigs({
      disabledIntegrations: new Set(["openai-codex", "googleadk", "vercel-ai"]),
    });

    expect(configs).not.toContain(openAICodexConfigs[0]);
    expect(configs).not.toContain(googleADKConfigs[0]);
    expect(configs).not.toContain(aiSDKConfigs[0]);
    expect(configs).toContain(openaiConfigs[0]);
  });
});
