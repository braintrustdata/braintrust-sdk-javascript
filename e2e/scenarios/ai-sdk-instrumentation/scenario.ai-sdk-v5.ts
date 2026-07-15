const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v5-latest";
const anthropicPackageName =
  process.env.AI_SDK_ANTHROPIC_PACKAGE_NAME ?? "ai-sdk-anthropic-v5-latest";
const coherePackageName =
  process.env.AI_SDK_COHERE_PACKAGE_NAME ?? "ai-sdk-cohere-v5-latest";
const openaiPackageName =
  process.env.AI_SDK_OPENAI_PACKAGE_NAME ?? "ai-sdk-openai-v5-latest";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runWrappedAISDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const ai = await import(aiPackageName);
  const { anthropic, createAnthropic } = await import(anthropicPackageName);
  const { cohere, createCohere } = await import(coherePackageName);
  const { createOpenAI, openai } = await import(openaiPackageName);

  await runWrappedAISDKInstrumentation({
    agentClassExport: "Experimental_Agent",
    agentSpanName: "Agent",
    ai,
    anthropic,
    cohere,
    createAnthropic,
    createCohere,
    createOpenAI,
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      aiPackageName,
    ),
    supportsEmbedMany: false,
    supportsGenerateObject: true,
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  });
});
