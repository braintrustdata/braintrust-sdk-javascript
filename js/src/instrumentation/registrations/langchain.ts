import { registerLangChainInstrumentation } from "../providers/langchain-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("langchain", () => {
    registerLangChainInstrumentation();
  });
}
