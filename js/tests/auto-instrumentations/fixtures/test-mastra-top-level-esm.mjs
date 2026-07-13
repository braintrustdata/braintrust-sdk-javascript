import { parentPort } from "node:worker_threads";

if (process.env.BRAINTRUST_TEST_ENABLE_MASTRA_PLUGIN !== "false") {
  await import("braintrust");
}

const { Mastra } = await import("@mastra/core");
const { Mastra: SubpathMastra } = await import("@mastra/core/mastra");
const { Observability } = await import("@mastra/observability");

const root = new Mastra({});
const subpath = new SubpathMastra({});
const userObservability = new Observability({
  custom: "kept",
  configs: {
    default: {
      exporters: [{ name: "other" }],
      serviceName: "user-service",
    },
  },
});
const withUserObservability = new Mastra({
  observability: userObservability,
});

parentPort?.postMessage({
  result: {
    root: summarize(root),
    subpath: summarize(subpath),
    userConfig: userObservability.config,
    userObservabilityPreserved:
      withUserObservability.observability === userObservability,
  },
  type: "mastra-result",
});

function summarize(mastra) {
  return {
    exporters:
      mastra.observability?.config?.configs?.default?.exporters?.map(
        (exporter) => exporter.name,
      ) ?? [],
    hasObservability: Boolean(mastra.observability),
  };
}
