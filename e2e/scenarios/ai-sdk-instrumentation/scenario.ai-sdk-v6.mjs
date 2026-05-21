import { createOpenAI, openai } from "ai-sdk-openai-v6";
import * as ai from "ai-sdk-v6";
import { getInstalledPackageVersion } from "../../helpers/provider-runtime.mjs";
import { runAutoAISDKInstrumentationOrExit } from "./scenario.impl.mjs";

runAutoAISDKInstrumentationOrExit({
  agentClassExport: "ToolLoopAgent",
  ai,
  agentSpanName: "ToolLoopAgent",
  createOpenAI,
  maxTokensKey: "maxOutputTokens",
  openai,
  sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v6"),
  supportsEmbedMany: false,
  supportsGenerateObject: true,
  supportsStreamObject: true,
  supportsToolExecution: true,
  toolSchemaKey: "inputSchema",
});
