const { parentPort } = require("node:worker_threads");
const { Mastra } = require("@mastra/core");

const mastra = new Mastra({});
parentPort?.postMessage({
  result: {
    exporters:
      mastra.observability?.config?.configs?.default?.exporters?.map(
        (exporter) => exporter.name,
      ) ?? [],
    hasObservability: Boolean(mastra.observability),
  },
  type: "mastra-result",
});
