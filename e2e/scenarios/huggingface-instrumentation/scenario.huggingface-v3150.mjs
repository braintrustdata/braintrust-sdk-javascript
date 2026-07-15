const huggingFacePackageName =
  process.env.HUGGINGFACE_PACKAGE_NAME ?? "huggingface-inference-sdk-v3-latest";
const huggingFace = await import(huggingFacePackageName);
import { runMain } from "../../helpers/provider-runtime.mjs";
import { runAutoHuggingFaceInstrumentation } from "./scenario.impl.mjs";

runMain(async () => runAutoHuggingFaceInstrumentation(huggingFace));
