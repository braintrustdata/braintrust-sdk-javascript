import { createOpenAI, openai } from "ai-sdk-openai-v6";
import * as ai from "ai-sdk-v6";
import * as z from "zod";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runAISDKOtelExport } from "./scenario.impl";

runMain(async () =>
  runAISDKOtelExport({
    ai,
    createOpenAI,
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v6"),
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
    zod: z,
  }),
);
