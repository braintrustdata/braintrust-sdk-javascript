import { registerOpenRouterInstrumentation } from "../providers/openrouter-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("openrouter", () => {
    registerOpenRouterInstrumentation();
  });
}
