import { registerPiCodingAgentInstrumentation } from "../providers/pi-coding-agent-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("piCodingAgent", () => {
    registerPiCodingAgentInstrumentation();
  });
}
