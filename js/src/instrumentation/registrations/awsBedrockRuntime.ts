import { registerBedrockRuntimeInstrumentation } from "../providers/bedrock-runtime-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("awsBedrockRuntime", () => {
    registerBedrockRuntimeInstrumentation();
  });
}
