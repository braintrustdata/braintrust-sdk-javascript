import { registerTypeSafeInstrumentation } from "../providers/typesafe-instrumentation";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("typesafe", () => {
    registerTypeSafeInstrumentation();
  });
}
