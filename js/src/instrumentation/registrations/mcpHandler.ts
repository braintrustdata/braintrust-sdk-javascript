import { registerMCPHandlerInstrumentation } from "../providers/mcp-handler-plugin";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("mcpHandler", (integrations) => {
    registerMCPHandlerInstrumentation(
      typeof integrations.mcpHandler === "object"
        ? integrations.mcpHandler
        : {},
    );
  });
}
