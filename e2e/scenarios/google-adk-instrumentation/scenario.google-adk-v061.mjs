const googleADKPackageName =
  process.env.GOOGLE_ADK_PACKAGE_NAME ?? "google-adk-sdk-v0-latest";
const adk = await import(googleADKPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGoogleADKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoGoogleADKInstrumentation(adk));
