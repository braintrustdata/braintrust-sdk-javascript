const googleADKPackageName =
  process.env.GOOGLE_ADK_PACKAGE_NAME ?? "google-adk-sdk-v0-latest";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedGoogleADKInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const adk = await import(googleADKPackageName);
  await runWrappedGoogleADKInstrumentation(adk);
});
