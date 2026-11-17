import { registerGoogleGenerativeAIInstrumentation } from "../providers/google-generative-ai-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("googleGenerativeAI", () => {
    registerGoogleGenerativeAIInstrumentation();
  });
}
