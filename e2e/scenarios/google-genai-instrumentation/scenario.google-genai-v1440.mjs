import * as googleGenAI from "google-genai-sdk-v1440";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGoogleGenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoGoogleGenAIInstrumentation(googleGenAI));
