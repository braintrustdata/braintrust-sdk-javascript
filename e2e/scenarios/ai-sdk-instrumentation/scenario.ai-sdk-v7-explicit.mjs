import { createOpenAI, openai } from "ai-sdk-openai-v7";
import * as workflowAI from "ai";
import * as ai from "ai-sdk-v7";
import * as workflow from "ai-sdk-workflow-v1";
import { braintrustAISDKTelemetry, wrapAISDK } from "braintrust";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/provider-runtime.mjs";
import { runAutoAISDKInstrumentation } from "./scenario.impl.mjs";

ai.registerTelemetry(braintrustAISDKTelemetry());

runMain(async () =>
  runAutoAISDKInstrumentation({
    agentClassExport: "ToolLoopAgent",
    ai,
    createOpenAI,
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v7"),
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
    workflow: wrapAISDK(workflow),
    workflowAI,
    workflowVersion: await getInstalledPackageVersion(
      import.meta.url,
      "ai-sdk-workflow-v1",
    ),
    toolSchemaKey: "inputSchema",
  }),
);
