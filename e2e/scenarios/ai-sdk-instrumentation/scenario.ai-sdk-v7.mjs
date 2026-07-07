const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v7-latest";
const openaiPackageName =
  process.env.AI_SDK_OPENAI_PACKAGE_NAME ?? "ai-sdk-openai-v7-latest";
const ai = await import(aiPackageName);
const { createOpenAI, openai } = await import(openaiPackageName);
import { getInstalledPackageVersion } from "../../helpers/provider-runtime.mjs";
import { runAutoAISDKInstrumentationOrExit } from "./scenario.impl.mjs";

runAutoAISDKInstrumentationOrExit({
  agentClassExport: "ToolLoopAgent",
  ai,
  createOpenAI,
  maxTokensKey: "maxOutputTokens",
  openai,
  sdkVersion: await getInstalledPackageVersion(import.meta.url, aiPackageName),
  supportsAgentToolLoop: true,
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
});
