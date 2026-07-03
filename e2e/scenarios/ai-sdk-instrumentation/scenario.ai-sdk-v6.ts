import { createOpenAI, openai } from "ai-sdk-openai-v6";
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
    createOpenAI,
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v6"),
    supportsAgentToolLoop: true,
    supportsEmbedMany: false,
    supportsGenerateObject: true,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  }),
);
