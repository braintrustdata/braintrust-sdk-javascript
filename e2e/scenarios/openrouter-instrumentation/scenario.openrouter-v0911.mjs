const openRouterPackageName =
  process.env.OPENROUTER_PACKAGE_NAME ?? "openrouter-sdk-v0";
const { OpenRouter } = await import(openRouterPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoOpenRouterInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoOpenRouterInstrumentation(OpenRouter, {
    supportsRerank: false,
  }),
);
