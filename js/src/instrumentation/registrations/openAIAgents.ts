import { registerOpenAIAgentsInstrumentation } from "../providers/openai-agents-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("openAIAgents", () => {
    registerOpenAIAgentsInstrumentation();
  });
}
