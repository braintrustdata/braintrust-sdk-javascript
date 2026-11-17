import { registerWorkersAIInstrumentation } from "../providers/workers-ai-plugin";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("workersAI", () => {
    registerWorkersAIInstrumentation();
  });
}
