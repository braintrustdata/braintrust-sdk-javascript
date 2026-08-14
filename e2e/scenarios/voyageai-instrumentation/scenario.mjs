const voyageAIPackageName =
  process.env.VOYAGEAI_PACKAGE_NAME ?? "voyageai-sdk-v0-latest";
const voyageAI = await import(voyageAIPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoVoyageAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoVoyageAIInstrumentation(voyageAI));
