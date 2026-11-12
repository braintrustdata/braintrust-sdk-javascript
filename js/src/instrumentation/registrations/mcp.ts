import { registerMCPInstrumentation } from "../providers/mcp-plugin";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("mcp", (integrations) => {
    registerMCPInstrumentation(
      typeof integrations.mcp === "object" ? integrations.mcp : {},
    );
  });
}
