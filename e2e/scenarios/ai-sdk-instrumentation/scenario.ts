import { anthropic, createAnthropic } from "ai-sdk-anthropic-v6";
import { createOpenAI, openai } from "ai-sdk-openai-v6";
import { cohere, createCohere } from "ai-sdk-cohere-v6";
import * as ai from "ai-sdk-v6";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runWrappedAISDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runWrappedAISDKInstrumentation({
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
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v6"),
    supportsEmbedMany: false,
    supportsGenerateObject: true,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  }),
);
