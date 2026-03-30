import * as googleGenAI from "google-genai-sdk-v1450";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedGoogleGenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedGoogleGenAIInstrumentation(googleGenAI));
