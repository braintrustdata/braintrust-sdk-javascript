import * as huggingFace from "huggingface-inference-sdk-v3";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedHuggingFaceInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedHuggingFaceInstrumentation(huggingFace));
