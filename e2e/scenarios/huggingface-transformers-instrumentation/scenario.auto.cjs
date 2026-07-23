const packageName = process.env.HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME;
if (!packageName) {
  throw new Error("HUGGINGFACE_TRANSFORMERS_PACKAGE_NAME must be set");
}

const sdk = require(packageName);
void import("./scenario.impl.mjs").then(({ runScenario }) => runScenario(sdk));
