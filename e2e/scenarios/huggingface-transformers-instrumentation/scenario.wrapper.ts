import { wrapHuggingFaceTransformers } from "braintrust";
import { runScenario, withFixturePipelineFactory } from "./scenario.impl.mjs";

const packageName = process.env.HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME;
if (!packageName) {
  throw new Error("HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME must be set");
}

const sdk = await import(packageName);
await runScenario(
  wrapHuggingFaceTransformers(withFixturePipelineFactory(sdk)),
  { usePipelineFactory: true },
);
