import { wrapAISDK, wrapStagehand } from "braintrust";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runStagehandInstrumentationScenario } from "./scenario.impl.mjs";

runMain(async () => {
  const packageName = process.env.STAGEHAND_PACKAGE_NAME;
  if (!packageName) throw new Error("STAGEHAND_PACKAGE_NAME is required");
  const sdk = await import(packageName);
  const ai = await import("ai");
  await runStagehandInstrumentationScenario(sdk, ai, wrapStagehand, wrapAISDK);
});
