import { registerVoyageAIInstrumentation } from "../providers/voyageai-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("voyageai", () => {
    registerVoyageAIInstrumentation();
  });
}
