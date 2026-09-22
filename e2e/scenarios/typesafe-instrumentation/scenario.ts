const packageName =
  process.env.TYPESAFE_PACKAGE_NAME ?? "typesafe-sdk-v0-latest";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runWrappedTypeSafeInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const typesafe = await import(packageName);
  await runWrappedTypeSafeInstrumentation(typesafe);
});
