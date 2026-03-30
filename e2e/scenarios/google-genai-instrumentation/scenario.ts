import * as googleGenAI from "@google/genai";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedGoogleGenAIInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedGoogleGenAIInstrumentation(googleGenAI));
