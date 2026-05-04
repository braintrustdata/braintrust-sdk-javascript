import { wrapOpenAICodexSDK } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_NAME = "openai-codex-instrumentation-root";
export const SCENARIO_NAME = "openai-codex-instrumentation";

const SCENARIO_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CODEX_PATH = path.join(SCENARIO_DIR, "mock-codex-cli.mjs");

function createClient(SDK) {
  const { Codex } = SDK;
  return new Codex({
    apiKey: "test-key",
    codexPathOverride: MOCK_CODEX_PATH,
    env: {
      PATH: process.env.PATH ?? "",
    },
  });
}

function startThread(client) {
  return client.startThread({
    approvalPolicy: "never",
    model: "gpt-5-codex",
    modelReasoningEffort: "low",
    networkAccessEnabled: false,
    sandboxMode: "danger-full-access",
    webSearchMode: "disabled",
    workingDirectory: process.cwd(),
  });
}

async function runOpenAICodexScenario({ decorateSDK, sdk }) {
  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const client = createClient(instrumentedSDK);

  await runTracedScenario({
    callback: async () => {
      await runOperation("openai-codex-run-operation", "run", async () => {
        const thread = startThread(client);
        await thread.run("Return Codex RUN_OK after using a command.");
      });

      await runOperation(
        "openai-codex-run-streamed-operation",
        "runStreamed",
        async () => {
          const thread = startThread(client);
          const streamedTurn = await thread.runStreamed(
            "Return Codex STREAM_OK after using a command in stream mode.",
          );
          await collectAsync(streamedTurn.events);
        },
      );
    },
    flushCount: 2,
    flushDelayMs: 100,
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-openai-codex-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedOpenAICodexInstrumentation(sdk) {
  await runOpenAICodexScenario({
    decorateSDK: wrapOpenAICodexSDK,
    sdk,
  });
}

export async function runAutoOpenAICodexInstrumentation(sdk) {
  await runOpenAICodexScenario({
    sdk,
  });
}
