import { registerGitHubCopilotInstrumentation } from "../providers/github-copilot-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("gitHubCopilot", () => {
    registerGitHubCopilotInstrumentation();
  });
}
