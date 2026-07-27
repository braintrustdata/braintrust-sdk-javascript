import { configureHuggingFaceHub, runScenario } from "./scenario.impl.mjs";

const packageName = process.env.HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME;
if (!packageName) {
  throw new Error("HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME must be set");
}

const sdk = await import(packageName);
configureHuggingFaceHub(sdk);
await runScenario(sdk);
