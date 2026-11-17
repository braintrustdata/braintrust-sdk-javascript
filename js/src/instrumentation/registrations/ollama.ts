import { registerOllamaInstrumentation } from "../providers/ollama-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("ollama", () => {
    registerOllamaInstrumentation();
  });
}
