import * as huggingFace from "huggingface-inference-sdk-v3";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoHuggingFaceInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoHuggingFaceInstrumentation(huggingFace));
