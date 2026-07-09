const openRouterPackageName =
  process.env.OPENROUTER_PACKAGE_NAME ?? "openrouter-sdk-v0";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedOpenRouterInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const { OpenRouter } = await import(openRouterPackageName);
  await runWrappedOpenRouterInstrumentation(OpenRouter, {
    supportsRerank: false,
  });
});
