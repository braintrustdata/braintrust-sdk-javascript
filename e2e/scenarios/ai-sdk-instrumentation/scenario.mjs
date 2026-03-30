import { openai } from "ai-sdk-openai-v6";
import * as ai from "ai-sdk-v6";
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
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v6"),
    supportsGenerateObject: true,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  }),
);
