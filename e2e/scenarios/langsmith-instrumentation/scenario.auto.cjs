const root = require("langsmith-v081");
const client = require("langsmith-v081/client");
const openAI = require("openai");
const openAIWrapper = require("langsmith-v081/wrappers");
const runTrees = require("langsmith-v081/run_trees");
const traceable = require("langsmith-v081/traceable");

void (async () => {
  const { runMain } = await import("../../helpers/provider-runtime.mjs");
  const { runLangSmithScenario } = await import("./scenario.impl.mjs");

  runMain(async () => {
    await runLangSmithScenario({
      namespaces: { root, client, openAI, openAIWrapper, runTrees, traceable },
      wrapped: false,
    });
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
