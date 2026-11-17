import { registerOpenAICodexInstrumentation } from "../providers/openai-codex-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("openaiCodexSDK", () => {
    registerOpenAICodexInstrumentation();
  });
}
