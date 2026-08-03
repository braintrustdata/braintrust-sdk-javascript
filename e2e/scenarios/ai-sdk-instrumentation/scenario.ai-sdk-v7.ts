const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v7-latest";
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
  const { cohere, createCohere } = await import(coherePackageName);
  const { createOpenAI, openai } = await import(openaiPackageName);

  ai.registerTelemetry(braintrustAISDKTelemetry());

  await runAutoAISDKInstrumentation({
    agentClassExport: "ToolLoopAgent",
    ai,
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
    supportsOpenAICacheScenario: false,
    supportsOutputObjectScenario: true,
    supportsProviderCacheAssertions: false,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  });
});
