import { registerDeepgramInstrumentation } from "../providers/deepgram-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("deepgram", () => {
    registerDeepgramInstrumentation();
  });
}
