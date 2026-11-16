import { registerLangSmithInstrumentation } from "../providers/langsmith-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("langsmith", () => {
    registerLangSmithInstrumentation({
      skipLangChainRuns: () => registry.isRegistered("langchain"),
    });
  });
}
