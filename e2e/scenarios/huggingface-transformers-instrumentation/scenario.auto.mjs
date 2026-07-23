import { runScenario } from "./scenario.impl.mjs";

const packageName = process.env.HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME;
if (!packageName) {
  throw new Error("HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME must be set");
}

const sdk = await import(packageName);
await runScenario(sdk);
