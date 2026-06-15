import * as googleGenAI from "google-genai-sdk-v280";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGoogleGenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoGoogleGenAIInstrumentation(googleGenAI, {
    includeInteractions: true,
  }),
);
