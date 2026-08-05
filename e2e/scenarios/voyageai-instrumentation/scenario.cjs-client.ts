import { createRequire } from "node:module";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedVoyageAIInstrumentation } from "./scenario.impl.mjs";

const require = createRequire(import.meta.url);
const voyageAIPackageName =
  process.env.VOYAGEAI_PACKAGE_NAME ?? "voyageai-sdk-v0";

runMain(async () => {
  const voyageAI = require(voyageAIPackageName);
  await runWrappedVoyageAIInstrumentation(voyageAI);
});
