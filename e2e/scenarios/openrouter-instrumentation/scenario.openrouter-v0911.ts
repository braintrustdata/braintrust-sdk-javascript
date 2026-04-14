import { OpenRouter } from "openrouter-sdk-v0911";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedOpenRouterInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runWrappedOpenRouterInstrumentation(OpenRouter, {
    supportsRerank: false,
  }),
);
