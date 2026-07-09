const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v7-latest";
const openaiPackageName =
  process.env.AI_SDK_OPENAI_PACKAGE_NAME ?? "ai-sdk-openai-v7-latest";
const workflowPackageName = process.env.AI_SDK_WORKFLOW_PACKAGE_NAME;
const workflowAIPackageName = process.env.AI_SDK_WORKFLOW_AI_PACKAGE_NAME;
import * as pinnedWorkflowAI from "ai";
import * as pinnedWorkflow from "ai-sdk-workflow-v1";
const ai = await import(aiPackageName);
const { createOpenAI, openai } = await import(openaiPackageName);
const workflow = workflowPackageName
  ? workflowPackageName === "ai-sdk-workflow-v1"
    ? pinnedWorkflow
    : await import(workflowPackageName)
  : undefined;
const workflowAI = workflowAIPackageName
  ? workflowAIPackageName === "ai"
    ? pinnedWorkflowAI
    : await import(workflowAIPackageName)
  : undefined;
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
  ...(workflow && workflowPackageName
    ? {
        workflow,
        workflowAI,
        workflowVersion: await getInstalledPackageVersion(
          import.meta.url,
          workflowPackageName,
        ),
      }
    : {}),
  toolSchemaKey: "inputSchema",
});
