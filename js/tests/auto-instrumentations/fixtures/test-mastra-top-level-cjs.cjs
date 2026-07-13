const { parentPort } = require("node:worker_threads");
require("braintrust");
const { Mastra } = require("@mastra/core");
const { Mastra: SubpathMastra } = require("@mastra/core/mastra");
const { Observability } = require("@mastra/observability");

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
