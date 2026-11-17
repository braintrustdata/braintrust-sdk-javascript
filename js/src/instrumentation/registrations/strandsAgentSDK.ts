import { registerStrandsAgentSDKInstrumentation } from "../providers/strands-agent-sdk-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("strandsAgentSDK", () => {
    registerStrandsAgentSDKInstrumentation();
  });
}
