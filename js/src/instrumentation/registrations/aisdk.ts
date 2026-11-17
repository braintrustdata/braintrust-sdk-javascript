import { registerAISDKInstrumentation } from "../providers/ai-sdk-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("aisdk", () => {
    registerAISDKInstrumentation();
  });
}
