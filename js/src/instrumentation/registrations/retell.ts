import { registerRetellInstrumentation } from "../providers/retell-instrumentation";
import { registry } from "../registry";

export function registerInstrumentation(): void {
  registry.register("retell", registerRetellInstrumentation);
}
