import * as huggingFace from "huggingface-inference-sdk-v2";
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoHuggingFaceInstrumentation } from "./scenario.impl.mjs";

runMain(async () =>
  runAutoHuggingFaceInstrumentation(huggingFace, {
    supportsLiveTextGeneration: false,
  }),
);
