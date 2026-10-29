import { registerHuggingFaceInstrumentation } from "../providers/huggingface-instrumentation";
import { registerHuggingFaceTransformersInstrumentation } from "../providers/huggingface-transformers-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("huggingface", () => {
    registerHuggingFaceInstrumentation();
    registerHuggingFaceTransformersInstrumentation();
  });
}
