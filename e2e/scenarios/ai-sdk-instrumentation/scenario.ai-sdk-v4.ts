import { openai } from "ai-sdk-openai-v4";
import * as ai from "ai-sdk-v4";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runWrappedAISDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runWrappedAISDKInstrumentation({
    ai,
    maxTokensKey: "maxTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(import.meta.url, "ai-sdk-v4"),
    supportsGenerateObject: true,
    supportsStreamObject: true,
    supportsToolExecution: false,
    toolSchemaKey: "parameters",
  }),
);
