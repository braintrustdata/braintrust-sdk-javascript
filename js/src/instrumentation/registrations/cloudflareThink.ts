import { registerCloudflareThinkInstrumentation } from "../providers/cloudflare-think-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("cloudflareThink", () => {
    registerCloudflareThinkInstrumentation();
  });
}
