const root = require("langsmith-v0-latest");
const client = require("langsmith-v0-latest/client");
const openAI = require("openai");
const openAIWrapper = require("langsmith-v0-latest/wrappers");
const runTrees = require("langsmith-v0-latest/run_trees");
const traceable = require("langsmith-v0-latest/traceable");

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
