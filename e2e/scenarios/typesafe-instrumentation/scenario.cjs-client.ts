import { createRequire } from "node:module";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedTypeSafeInstrumentation } from "./scenario.impl.mjs";

const require = createRequire(import.meta.url);
const packageName = process.env.TYPESAFE_PACKAGE_NAME ?? "typesafe-sdk-v0";

runMain(async () => {
  await runWrappedTypeSafeInstrumentation(require(packageName));
});
