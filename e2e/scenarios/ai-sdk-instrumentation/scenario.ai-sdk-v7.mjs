import { createOpenAI, openai } from "ai-sdk-openai-v7";
import * as workflowAI from "ai";
import * as ai from "ai-sdk-v7";
import * as workflow from "ai-sdk-workflow-v1";
import { getInstalledPackageVersion } from "../../helpers/provider-runtime.mjs";
import { runAutoAISDKInstrumentationOrExit } from "./scenario.impl.mjs";

runAutoAISDKInstrumentationOrExit({
  agentClassExport: "ToolLoopAgent",
  ai,
  createOpenAI,
  maxTokensKey: "maxOutputTokens",
  openai,
  sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v7"),
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
  workflow,
  workflowAI,
  workflowVersion: await getInstalledPackageVersion(
    import.meta.url,
    "ai-sdk-workflow-v1",
  ),
  toolSchemaKey: "inputSchema",
});
