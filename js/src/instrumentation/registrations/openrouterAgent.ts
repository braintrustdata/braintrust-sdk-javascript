import { registerOpenRouterAgentInstrumentation } from "../providers/openrouter-agent-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("openrouterAgent", () => {
    registerOpenRouterAgentInstrumentation();
  });
}
