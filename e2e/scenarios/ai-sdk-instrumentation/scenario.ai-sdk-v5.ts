import { openai } from "ai-sdk-openai-v5";
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
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v5"),
    supportsGenerateObject: true,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
  }),
);
