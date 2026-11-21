import { registerAgentKitInstrumentation } from "../providers/agent-kit-instrumentation";
import { registry } from "../registry";

export function registerInstrumentation(): void {
  registry.register("agentKit", registerAgentKitInstrumentation);
}
