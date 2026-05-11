import { wrapOpenAICodexSDK } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_NAME = "openai-codex-instrumentation-root";
export const SCENARIO_NAME = "openai-codex-instrumentation";

const SCENARIO_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CODEX_PATH = path.join(SCENARIO_DIR, "mock-codex-cli.mjs");
const RUN_MARKER = "OPENAI_CODEX_RUN_OK";
const STREAM_MARKER = "OPENAI_CODEX_STREAM_OK";

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

function stringEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
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

function scenarioMode() {
  const mode = process.env.OPENAI_CODEX_E2E_MODE ?? "mock";
  if (mode !== "mock" && mode !== "real") {
    throw new Error(
      `OPENAI_CODEX_E2E_MODE must be "mock" or "real", received ${JSON.stringify(mode)}`,
    );
  }
  return mode;
}

function createMockClient(SDK) {
  const { Codex } = SDK;
  return new Codex({
    apiKey: "test-key",
    codexPathOverride: MOCK_CODEX_PATH,
    env: {
      PATH: process.env.PATH ?? "",
    },
  });
}

function createRealClient(SDK) {
  const { Codex } = SDK;
  return new Codex({
    apiKey: requireOpenAIKey(),
    env: stringEnv(),
  });
}

function createClient(SDK, mode) {
  return mode === "real" ? createRealClient(SDK) : createMockClient(SDK);
}

function startThread(client, mode, workingDirectory) {
  return client.startThread({
    approvalPolicy: "never",
    model: process.env.OPENAI_CODEX_E2E_MODEL ?? "gpt-5-codex",
    modelReasoningEffort: "low",
    networkAccessEnabled: false,
    sandboxMode: mode === "real" ? "workspace-write" : "danger-full-access",
    ...(mode === "real" ? { skipGitRepoCheck: true } : {}),
    webSearchMode: "disabled",
    workingDirectory,
  });
}

async function createWorkspace(marker) {
  const workingDirectory = await mkdtemp(
    path.join(os.tmpdir(), "braintrust-codex-e2e-"),
  );
  await writeFile(
    path.join(workingDirectory, "codex-input.txt"),
    `The final answer marker is ${marker}.\n`,
    "utf8",
  );
  return workingDirectory;
}

function realPrompt(marker) {
  return [
    "You are running inside an SDK instrumentation test.",
    "Before answering, use the shell to run `cat codex-input.txt`.",
    "Then answer in one short sentence.",
    `The final response must include the exact marker ${marker}.`,
  ].join(" ");
}

function mockPrompt(marker, operation) {
  return `Return Codex ${marker} after using a command in ${operation} mode.`;
}

async function runOpenAICodexScenario({ decorateSDK, sdk }) {
  const mode = scenarioMode();
  if (mode === "real") {
    await loadRootEnv();
  }
  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const client = createClient(instrumentedSDK, mode);
  let runWorkingDirectory = process.cwd();
  let streamedWorkingDirectory = process.cwd();
  const runPrompt =
    mode === "real" ? realPrompt(RUN_MARKER) : mockPrompt(RUN_MARKER, "run");
  const streamedPrompt =
    mode === "real"
      ? realPrompt(STREAM_MARKER)
      : mockPrompt(STREAM_MARKER, "stream");

  try {
    if (mode === "real") {
      runWorkingDirectory = await createWorkspace(RUN_MARKER);
      streamedWorkingDirectory = await createWorkspace(STREAM_MARKER);
    }

    await runTracedScenario({
      callback: async () => {
        await runOperation("openai-codex-run-operation", "run", async () => {
          const thread = startThread(client, mode, runWorkingDirectory);
          await thread.run(runPrompt);
        });

        await runOperation(
          "openai-codex-run-streamed-operation",
          "runStreamed",
          async () => {
            const thread = startThread(client, mode, streamedWorkingDirectory);
            const streamedTurn = await thread.runStreamed(streamedPrompt);
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
  } finally {
    if (mode === "real") {
      await Promise.allSettled([
        rm(runWorkingDirectory, { force: true, recursive: true }),
        rm(streamedWorkingDirectory, { force: true, recursive: true }),
      ]);
    }
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
