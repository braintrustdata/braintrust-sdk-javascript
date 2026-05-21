import { anthropic, createAnthropic } from "ai-sdk-anthropic-v5";
import { createOpenAI, openai } from "ai-sdk-openai-v5";
import { cohere, createCohere } from "ai-sdk-cohere-v5";
import * as ai from "ai-sdk-v5";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runWrappedAISDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runWrappedAISDKInstrumentation({
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
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v5"),
    supportsEmbedMany: false,
    supportsGenerateObject: true,
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  }),
);
