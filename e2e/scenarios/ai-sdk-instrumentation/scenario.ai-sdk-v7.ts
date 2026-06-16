import { createOpenAI, openai } from "ai-sdk-openai-v7";
import * as ai from "ai-sdk-v7";
import { braintrustAISDKTelemetry } from "braintrust";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runAutoAISDKInstrumentation } from "./scenario.impl.mjs";

ai.registerTelemetry(braintrustAISDKTelemetry());

runMain(async () =>
  runAutoAISDKInstrumentation({
    ai,
    createOpenAI,
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v7"),
    supportsDenyOutputOverrideScenario: false,
    supportsEmbedMany: true,
    supportsGenerateObject: true,
    supportsOpenAICacheScenario: false,
    supportsOutputObjectScenario: true,
    supportsProviderCacheAssertions: false,
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  }),
);
