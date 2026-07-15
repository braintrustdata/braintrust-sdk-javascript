const huggingFacePackageName =
  process.env.HUGGINGFACE_PACKAGE_NAME ?? "huggingface-inference-sdk-v4-latest";
import { runMain } from "../../helpers/scenario-runtime";
import { runWrappedHuggingFaceInstrumentation } from "./scenario.impl.mjs";

runMain(async () => {
  const huggingFace = await import(huggingFacePackageName);
  await runWrappedHuggingFaceInstrumentation(huggingFace);
});
