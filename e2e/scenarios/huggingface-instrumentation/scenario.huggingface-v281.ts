import * as huggingFace from "huggingface-inference-sdk-v2";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedHuggingFaceInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runWrappedHuggingFaceInstrumentation(huggingFace, {
    supportsLiveTextGeneration: false,
  }),
);
