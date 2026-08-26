const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v7-latest";
const anthropicPackageName =
  process.env.AI_SDK_ANTHROPIC_PACKAGE_NAME ?? "ai-sdk-anthropic-v7-latest";
const coherePackageName =
  process.env.AI_SDK_COHERE_PACKAGE_NAME ?? "ai-sdk-cohere-v7-latest";
const openaiPackageName =
  process.env.AI_SDK_OPENAI_PACKAGE_NAME ?? "ai-sdk-openai-v7-latest";
import { braintrustAISDKTelemetry } from "braintrust";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runAutoAISDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const ai = await import(aiPackageName);
  const { anthropic, createAnthropic } = await import(anthropicPackageName);
  const { cohere, createCohere } = await import(coherePackageName);
  const { createOpenAI, openai } = await import(openaiPackageName);

  ai.registerTelemetry(braintrustAISDKTelemetry());

  await runAutoAISDKInstrumentation({
    agentClassExport: "ToolLoopAgent",
    ai,
    anthropic,
    createAnthropic,
    cohere,
    createCohere,
    createOpenAI,
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      aiPackageName,
    ),
    supportsDenyOutputOverrideScenario: false,
    supportsAgentToolLoop: true,
    supportsEmbedMany: true,
    supportsGenerateObject: true,
    supportsGenerateImage: false,
    supportsOpenAICacheScenario: false,
    supportsOutputObjectScenario: true,
    supportsProviderCacheAssertions: true,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  });
});
