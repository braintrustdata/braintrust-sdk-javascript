const packageName =
  process.env.TYPESAFE_PACKAGE_NAME ?? "typesafe-sdk-v0-latest";
const typesafe = await import(packageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoTypeSafeInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoTypeSafeInstrumentation(typesafe));
