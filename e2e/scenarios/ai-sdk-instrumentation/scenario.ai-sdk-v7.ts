const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v7-latest";
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
  const { createOpenAI, openai } = await import(openaiPackageName);

  ai.registerTelemetry(braintrustAISDKTelemetry());

  await runAutoAISDKInstrumentation({
    agentClassExport: "ToolLoopAgent",
    ai,
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
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  });
});
