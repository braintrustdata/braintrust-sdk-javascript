import { registerCohereInstrumentation } from "../providers/cohere-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("cohere", () => {
    registerCohereInstrumentation();
  });
}
