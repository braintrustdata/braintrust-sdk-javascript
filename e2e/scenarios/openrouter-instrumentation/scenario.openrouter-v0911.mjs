import { OpenRouter } from "openrouter-sdk-v0911";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoOpenRouterInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoOpenRouterInstrumentation(OpenRouter, {
    supportsRerank: false,
  }),
);
