import { registerGoogleGenAIInstrumentation } from "../providers/google-genai-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("googleGenAI", () => {
    registerGoogleGenAIInstrumentation();
  });
}
