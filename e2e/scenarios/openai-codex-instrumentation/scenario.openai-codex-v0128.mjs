const openAICodexPackageName =
  process.env.OPENAI_CODEX_PACKAGE_NAME ?? "openai-codex-sdk-v0-latest";
const OpenAICodexSDK = await import(
  `./node_modules/${openAICodexPackageName}/dist/index.js`
);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoOpenAICodexInstrumentation } from "./scenario.impl.mjs";

runMain(() => runAutoOpenAICodexInstrumentation(OpenAICodexSDK));
