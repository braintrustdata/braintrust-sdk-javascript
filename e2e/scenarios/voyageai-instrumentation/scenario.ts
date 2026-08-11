const voyageAIPackageName =
  process.env.VOYAGEAI_PACKAGE_NAME ?? "voyageai-sdk-v0-latest";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedVoyageAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const voyageAI = await import(voyageAIPackageName);
  await runWrappedVoyageAIInstrumentation(voyageAI);
});
