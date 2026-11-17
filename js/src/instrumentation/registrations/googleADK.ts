import { registerGoogleADKInstrumentation } from "../providers/google-adk-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("googleADK", () => {
    registerGoogleADKInstrumentation();
  });
}
