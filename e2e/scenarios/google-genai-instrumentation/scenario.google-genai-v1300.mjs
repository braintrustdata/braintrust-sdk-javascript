const googleGenAIPackageName =
  process.env.GOOGLE_GENAI_PACKAGE_NAME ?? "google-genai-sdk-v1";
const googleGenAI = await import(googleGenAIPackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGoogleGenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoGoogleGenAIInstrumentation(googleGenAI));
