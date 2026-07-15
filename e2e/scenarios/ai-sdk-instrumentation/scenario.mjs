const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v6-latest";
const anthropicPackageName =
  process.env.AI_SDK_ANTHROPIC_PACKAGE_NAME ?? "ai-sdk-anthropic-v6-latest";
const coherePackageName =
  process.env.AI_SDK_COHERE_PACKAGE_NAME ?? "ai-sdk-cohere-v6-latest";
const openaiPackageName =
  process.env.AI_SDK_OPENAI_PACKAGE_NAME ?? "ai-sdk-openai-v6-latest";
const ai = await import(aiPackageName);
const { anthropic, createAnthropic } = await import(anthropicPackageName);
const { cohere, createCohere } = await import(coherePackageName);
const { createOpenAI, openai } = await import(openaiPackageName);
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/provider-runtime.mjs";
import { runAutoAISDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoAISDKInstrumentation({
    agentClassExport: "ToolLoopAgent",
    agentSpanName: "ToolLoopAgent",
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
    supportsAgentToolLoop: true,
    supportsEmbedMany: false,
    supportsGenerateObject: true,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  }),
);
