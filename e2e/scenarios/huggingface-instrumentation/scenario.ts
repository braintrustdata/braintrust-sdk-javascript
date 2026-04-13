import * as huggingFace from "@huggingface/inference";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedHuggingFaceInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runWrappedHuggingFaceInstrumentation(huggingFace));
