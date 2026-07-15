const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v4-latest";
const openaiPackageName =
  process.env.AI_SDK_OPENAI_PACKAGE_NAME ?? "ai-sdk-openai-v4-latest";
const ai = await import(aiPackageName);
const { createOpenAI, openai } = await import(openaiPackageName);
import { getInstalledPackageVersion } from "../../helpers/provider-runtime.mjs";
import { runAutoAISDKInstrumentationOrExit } from "./scenario.impl.mjs";

runAutoAISDKInstrumentationOrExit({
  ai,
  createOpenAI,
  maxTokensKey: "maxTokens",
  openai,
  sdkVersion: await getInstalledPackageVersion(import.meta.url, aiPackageName),
  supportsEmbedMany: false,
  supportsGenerateObject: true,
  supportsRerank: false,
  supportsStreamObject: true,
  supportsToolExecution: false,
  toolSchemaKey: "parameters",
});
