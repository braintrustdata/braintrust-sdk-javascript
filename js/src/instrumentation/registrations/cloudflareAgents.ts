import { registerCloudflareAgentsInstrumentation } from "../providers/cloudflare-agents-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("cloudflareAgents", () => {
    registerCloudflareAgentsInstrumentation();
  });
}
