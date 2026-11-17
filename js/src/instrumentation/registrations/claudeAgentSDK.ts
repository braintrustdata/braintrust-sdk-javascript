import { registerClaudeAgentSDKInstrumentation } from "../providers/claude-agent-sdk-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("claudeAgentSDK", () => {
    registerClaudeAgentSDKInstrumentation();
  });
}
