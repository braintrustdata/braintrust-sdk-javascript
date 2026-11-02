import { registerCloudflareAIChatInstrumentation } from "../providers/cloudflare-ai-chat-consumer";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("cloudflareAIChat", () => {
    registerCloudflareAIChatInstrumentation();
  });
}
