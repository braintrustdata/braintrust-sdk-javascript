import * as googleGenAI from "google-genai-sdk-v280";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedGoogleGenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runWrappedGoogleGenAIInstrumentation(googleGenAI, {
    includeInteractions: true,
  }),
);
