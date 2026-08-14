import { createRequire } from "node:module";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoVoyageAIInstrumentation } from "./scenario.impl.mjs";

const require = createRequire(import.meta.url);
const voyageAIPackageName =
  process.env.VOYAGEAI_PACKAGE_NAME ?? "voyageai-sdk-v0";
const voyageAI = require(voyageAIPackageName);

runMain(async () => runAutoVoyageAIInstrumentation(voyageAI));
