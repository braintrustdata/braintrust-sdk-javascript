import { registry } from "../registry";
import { installMastraExporterFactory } from "../../auto-instrumentations/loader/mastra-observability-patch";
import { BraintrustObservabilityExporter } from "../../wrappers/mastra";

export function registerInstrumentation(): void {
  registry.register("mastra", () => {
    installMastraExporterFactory(() => new BraintrustObservabilityExporter());
  });
}
