import { registerFastMCPInstrumentation } from "../providers/fastmcp-plugin";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("fastmcp", (integrations) => {
    registerFastMCPInstrumentation(
      typeof integrations.fastmcp === "object" ? integrations.fastmcp : {},
    );
  });
}
