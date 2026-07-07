const openAICodexPackageName =
  process.env.OPENAI_CODEX_PACKAGE_NAME ?? "openai-codex-sdk-v0-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedOpenAICodexInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const OpenAICodexSDK = await import(
    `./node_modules/${openAICodexPackageName}/dist/index.js`
  );
  await runWrappedOpenAICodexInstrumentation(OpenAICodexSDK);
});
