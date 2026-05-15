import { wrapOpenAICodexSDK } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT_NAME = "openai-codex-instrumentation-root";
export const SCENARIO_NAME = "openai-codex-instrumentation";

const RUN_MARKER = "OPENAI_CODEX_RUN_OK";
const STREAM_MARKER = "OPENAI_CODEX_STREAM_OK";
const SCENARIO_TMP_PREFIX = "braintrust-codex-e2e-openai-codex-instrumentation";

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return;
  }

  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed;
  const separator = withoutExport.indexOf("=");
  if (separator <= 0) {
    return;
  }

  const key = withoutExport.slice(0, separator).trim();
  let value = withoutExport.slice(separator + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

async function loadRootEnv() {
  const repoRoot = process.env.BRAINTRUST_E2E_REPO_ROOT;
  if (!repoRoot) {
    return;
  }

  let contents;
  try {
    contents = await readFile(path.join(repoRoot, ".env"), "utf8");
  } catch {
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed && process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

function scenarioVariant() {
  return (process.env.BRAINTRUST_E2E_CASSETTE_VARIANT ?? "local").replace(
    /[^a-zA-Z0-9_.-]/g,
    "_",
  );
}

function codexEnv(codexHome) {
  const env = {
    CODEX_HOME: codexHome,
  };
  for (const key of ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR"]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function requireOpenAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required to run openai-codex-instrumentation against the real Codex SDK",
    );
  }
  return apiKey;
}

function createClient(SDK, codexHome) {
  const { Codex } = SDK;
  const baseUrl =
    process.env.BRAINTRUST_E2E_MODEL_BASE_URL || process.env.OPENAI_BASE_URL;
  return new Codex({
    apiKey: requireOpenAIKey(),
    config: {
      model_provider: "openai-codex-e2e",
      model_providers: {
        "openai-codex-e2e": {
          base_url: baseUrl ?? "https://api.openai.com/v1",
          env_key: "CODEX_API_KEY",
          name: "OpenAI Codex E2E",
          requires_openai_auth: false,
          supports_websockets: false,
          wire_api: "responses",
        },
      },
    },
    env: codexEnv(codexHome),
  });
}

function startThread(client, workingDirectory) {
  return client.startThread({
    approvalPolicy: "never",
    model: process.env.OPENAI_CODEX_E2E_MODEL ?? "gpt-5-codex",
    modelReasoningEffort: "low",
    networkAccessEnabled: false,
    sandboxMode: "workspace-write",
    skipGitRepoCheck: true,
    webSearchMode: "disabled",
    workingDirectory,
  });
}

async function createWorkspace(root, marker) {
  const workingDirectory = path.join(
    root,
    marker === RUN_MARKER ? "run" : "stream",
  );
  await mkdir(workingDirectory, { recursive: true });
  await writeFile(
    path.join(workingDirectory, "codex-input.txt"),
    `The final answer marker is ${marker}.\n`,
    "utf8",
  );
  return workingDirectory;
}

async function createScenarioRoot() {
  return mkdtemp(
    path.join(tmpdir(), `${SCENARIO_TMP_PREFIX}-${scenarioVariant()}-`),
  );
}

async function createCodexHome(root) {
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  return codexHome;
}

function realPrompt(marker) {
  return [
    "You are running inside an SDK instrumentation test.",
    "First run exactly this shell command: cat codex-input.txt",
    "Do not prefix it with cd or any other command.",
    "After the command completes, reply with exactly this marker and no extra text:",
    marker,
  ].join(" ");
}

async function runOpenAICodexScenario({ decorateSDK, sdk }) {
  await loadRootEnv();
  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const scenarioRoot = await createScenarioRoot();
  const codexHome = await createCodexHome(scenarioRoot);
  const client = createClient(instrumentedSDK, codexHome);
  const runWorkingDirectory = await createWorkspace(scenarioRoot, RUN_MARKER);
  const streamedWorkingDirectory = await createWorkspace(
    scenarioRoot,
    STREAM_MARKER,
  );

  try {
    await runTracedScenario({
      callback: async () => {
        await runOperation("openai-codex-run-operation", "run", async () => {
          const thread = startThread(client, runWorkingDirectory);
          await thread.run(realPrompt(RUN_MARKER));
        });

        await runOperation(
          "openai-codex-run-streamed-operation",
          "runStreamed",
          async () => {
            const thread = startThread(client, streamedWorkingDirectory);
            const streamedTurn = await thread.runStreamed(
              realPrompt(STREAM_MARKER),
            );
            await collectAsync(streamedTurn.events);
          },
        );
      },
      flushCount: 4,
      flushDelayMs: 250,
      metadata: {
        scenario: SCENARIO_NAME,
      },
      projectNameBase: "e2e-openai-codex-instrumentation",
      rootName: ROOT_NAME,
    });
  } finally {
    await Promise.allSettled([
      rm(scenarioRoot, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ]);
  }
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
