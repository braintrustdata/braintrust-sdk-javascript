import { runMain } from "../../helpers/scenario-runtime";
import { runScenario } from "./scenario.impl.mjs";

const packageName =
  process.env.GOOGLE_GENERATIVE_AI_PACKAGE_NAME ??
  "google-generative-ai-sdk-v0-latest";

runMain(async () => {
  const sdk = await import(packageName);
  await runScenario(sdk, true);
});
