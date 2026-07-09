const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v5-latest";
const openaiPackageName =
  process.env.AI_SDK_OPENAI_PACKAGE_NAME ?? "ai-sdk-openai-v5-latest";
import * as z from "zod";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runAISDKOtelExport } from "./scenario.impl";

runMain(async () => {
  const ai = await import(aiPackageName);
  const { createOpenAI, openai } = await import(openaiPackageName);
  await runAISDKOtelExport({
    ai,
    createOpenAI,
    maxTokensKey: "maxOutputTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      aiPackageName,
    ),
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
    zod: z,
  });
});
