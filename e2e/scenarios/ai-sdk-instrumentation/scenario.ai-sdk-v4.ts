const aiPackageName = process.env.AI_SDK_PACKAGE_NAME ?? "ai-sdk-v4-latest";
const openaiPackageName =
  process.env.AI_SDK_OPENAI_PACKAGE_NAME ?? "ai-sdk-openai-v4-latest";
import {
  getInstalledPackageVersion,
  runMain,
} from "../../helpers/scenario-runtime";
import { runWrappedAISDKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const ai = await import(aiPackageName);
  const { createOpenAI, openai } = await import(openaiPackageName);

  await runWrappedAISDKInstrumentation({
    ai,
    createOpenAI,
    maxTokensKey: "maxTokens",
    openai,
    sdkVersion: await getInstalledPackageVersion(
      import.meta.url,
      aiPackageName,
    ),
    supportsEmbedMany: false,
    supportsGenerateObject: true,
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: false,
    toolSchemaKey: "parameters",
  });
});
