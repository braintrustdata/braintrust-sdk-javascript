const googleGenAIPackageName =
  process.env.GOOGLE_GENAI_PACKAGE_NAME ?? "google-genai-sdk-v2-latest";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedGoogleGenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const googleGenAI = await import(googleGenAIPackageName);
  await runWrappedGoogleGenAIInstrumentation(googleGenAI, {
    includeInteractions: true,
  });
});
