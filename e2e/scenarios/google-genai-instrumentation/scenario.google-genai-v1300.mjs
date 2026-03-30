import * as googleGenAI from "google-genai-sdk-v1300";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoGoogleGenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoGoogleGenAIInstrumentation(googleGenAI));
