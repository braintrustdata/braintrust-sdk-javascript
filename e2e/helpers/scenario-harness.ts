import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startMockBraintrustServer,
  type CapturedLogEvent,
  type CapturedLogPayload,
  type CapturedRequest,
  type JsonValue,
} from "./mock-braintrust-server";
import {
  installScenarioDependencies,
  isCanaryMode,
  prepareScenarioDir,
  readInstalledPackageVersion,
  type InstallScenarioDependenciesOptions,
  type InstallScenarioDependenciesResult,
} from "./scenario-installer";

type EventPredicate = (event: CapturedLogEvent) => boolean;
type PayloadPredicate = (payload: CapturedLogPayload) => boolean;
type RequestPredicate = (request: CapturedRequest) => boolean;

interface ScenarioResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const tsxCliPath = createRequire(import.meta.url).resolve("tsx/cli");
const DENO_COMMAND = process.platform === "win32" ? "deno.exe" : "deno";
const DEFAULT_SCENARIO_TIMEOUT_MS = 15_000;
const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HELPERS_DIR, "../..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTestRunId(value: unknown, testRunId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasTestRunId(entry, testRunId));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.testRunId === testRunId) {
    return true;
  }

  return Object.values(value).some((entry) => hasTestRunId(entry, testRunId));
}

function filterItems<T>(items: T[], predicate?: (item: T) => boolean): T[] {
  return predicate ? items.filter(predicate) : [...items];
}

function requestRowIdentity(row: Record<string, unknown>): string {
  return JSON.stringify(
    [
      "org_id",
      "project_id",
      "experiment_id",
      "dataset_id",
      "prompt_session_id",
      "log_id",
      "id",
    ].map((key) => row[key]),
  );
}

function mergeValue(base: unknown, incoming: unknown): unknown {
  if (isRecord(base) && isRecord(incoming)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value;
    }
    return merged;
  }

  return incoming;
}

function mergeRequestRow(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (!existing || incoming._is_merge !== true) {
    return structuredClone(incoming);
  }

  const preserveNoMerge = existing._is_merge !== true;
  const merged = mergeValue(existing, incoming) as Record<string, unknown>;
  if (preserveNoMerge) {
    delete merged._is_merge;
  }
  return structuredClone(merged);
}

function mergeLogs3RequestBody(
  left: JsonValue | null,
  right: JsonValue | null,
): JsonValue | null {
  if (
    !isRecord(left) ||
    !Array.isArray(left.rows) ||
    !isRecord(right) ||
    !Array.isArray(right.rows)
  ) {
    return right ?? left;
  }

  const mergedRows = new Map<string, Record<string, unknown>>();
  const rowOrder: string[] = [];
  for (const row of [...left.rows, ...right.rows]) {
    if (!isRecord(row)) {
      continue;
    }
    const key = requestRowIdentity(row);
    if (!mergedRows.has(key)) {
      rowOrder.push(key);
    }
    mergedRows.set(key, mergeRequestRow(mergedRows.get(key), row));
  }

  const rows = rowOrder
    .map((key) => mergedRows.get(key))
    .filter((row): row is Record<string, unknown> => row !== undefined);

  return {
    ...left,
    ...right,
    rows: rows as JsonValue[],
  } as JsonValue;
}

function normalizeCapturedRequests(
  requests: CapturedRequest[],
): CapturedRequest[] {
  const normalized: CapturedRequest[] = [];

  for (const request of requests) {
    const previous = normalized.at(-1);
    if (
      previous &&
      previous.method === "POST" &&
      previous.path === "/logs3" &&
      request.method === "POST" &&
      request.path === "/logs3"
    ) {
      const mergedBody = mergeLogs3RequestBody(
        previous.jsonBody,
        request.jsonBody,
      );
      normalized[normalized.length - 1] = {
        ...previous,
        jsonBody: mergedBody,
        rawBody:
          mergedBody === null ? previous.rawBody : JSON.stringify(mergedBody),
      };
      continue;
    }

    normalized.push(structuredClone(request));
  }

  return normalized;
}

function createTestRunId(): string {
  return `e2e-${randomUUID()}`;
}

function getTestServerEnv(
  testRunId: string,
  server: { apiKey: string; url: string },
  prodForwardingProjectName: string,
): Record<string, string> {
  return {
    BRAINTRUST_API_KEY: server.apiKey,
    BRAINTRUST_API_URL: server.url,
    BRAINTRUST_APP_URL: server.url,
    BRAINTRUST_APP_PUBLIC_URL: server.url,
    BRAINTRUST_E2E_PROJECT_NAME: prodForwardingProjectName,
    BRAINTRUST_PROXY_URL: server.url,
    BRAINTRUST_E2E_RUN_ID: testRunId,
    BRAINTRUST_E2E_REPO_ROOT: REPO_ROOT,
    BRAINTRUST_ORG_NAME: "mock-org",
  };
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ScenarioResult> {
  return await new Promise<ScenarioResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Process ${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function resolveEntryPath(scenarioDir: string, entry: string): string {
  return path.join(scenarioDir, entry);
}

async function runScenarioDirOrThrow(
  scenarioDir: string,
  env: Record<string, string>,
  options: {
    entry: string;
    nodeArgs?: string[];
    timeoutMs?: number;
    useTsx?: boolean;
  } = {
    entry: "scenario.ts",
  },
): Promise<ScenarioResult> {
  const scenarioPath = resolveEntryPath(scenarioDir, options.entry);
  const args =
    options.useTsx === false
      ? [...(options.nodeArgs ?? []), scenarioPath]
      : [tsxCliPath, scenarioPath];
  const result = await runProcess(
    process.execPath,
    args,
    scenarioDir,
    env,
    options.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Scenario ${path.join(scenarioDir, options.entry)} failed with exit code ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  return result;
}

export function resolveScenarioDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export async function runScenarioDir(options: {
  env?: Record<string, string>;
  entry?: string;
  scenarioDir: string;
  timeoutMs?: number;
}): Promise<ScenarioResult> {
  return await runScenarioDirOrThrow(options.scenarioDir, options.env ?? {}, {
    entry: options.entry ?? "scenario.ts",
    timeoutMs: options.timeoutMs,
  });
}

export async function runNodeScenarioDir(options: {
  env?: Record<string, string>;
  entry?: string;
  nodeArgs?: string[];
  scenarioDir: string;
  timeoutMs?: number;
}): Promise<ScenarioResult> {
  return await runScenarioDirOrThrow(options.scenarioDir, options.env ?? {}, {
    entry: options.entry ?? "scenario.mjs",
    nodeArgs: options.nodeArgs,
    timeoutMs: options.timeoutMs,
    useTsx: false,
  });
}

export async function runDenoScenarioDir(options: {
  args?: string[];
  entry?: string;
  env?: Record<string, string>;
  scenarioDir: string;
  timeoutMs?: number;
}): Promise<ScenarioResult> {
  const entry = options.entry ?? "runner.case.ts";
  const result = await runProcess(
    DENO_COMMAND,
    [
      "test",
      "--no-check",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      ...(options.args ?? []),
      resolveEntryPath(options.scenarioDir, entry),
    ],
    options.scenarioDir,
    options.env ?? {},
    options.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Scenario ${path.join(options.scenarioDir, entry)} failed with exit code ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  return result;
}

interface ScenarioHarness {
  events: (predicate?: EventPredicate) => CapturedLogEvent[];
  payloads: (predicate?: PayloadPredicate) => CapturedLogPayload[];
  requestCursor: () => number;
  requestsAfter: (
    after: number,
    predicate?: RequestPredicate,
  ) => CapturedRequest[];
  runDenoScenarioDir: (options: {
    args?: string[];
    entry?: string;
    env?: Record<string, string>;
    scenarioDir: string;
    timeoutMs?: number;
  }) => Promise<ScenarioResult>;
  runNodeScenarioDir: (options: {
    entry?: string;
    env?: Record<string, string>;
    nodeArgs?: string[];
    scenarioDir: string;
    timeoutMs?: number;
  }) => Promise<ScenarioResult>;
  runScenarioDir: (options: {
    entry?: string;
    env?: Record<string, string>;
    scenarioDir: string;
    timeoutMs?: number;
  }) => Promise<ScenarioResult>;
  testRunEvents: (predicate?: EventPredicate) => CapturedLogEvent[];
  testRunId: string;
}

export async function withScenarioHarness(
  body: (harness: ScenarioHarness) => Promise<void>,
): Promise<void> {
  const { getProdForwarding } = await import("./prod-forwarding");
  const prodForwarding = getProdForwarding();
  const testRunId = createTestRunId();
  const server = await startMockBraintrustServer({
    prodForwarding,
    testRunId,
  });
  const testEnv = getTestServerEnv(
    testRunId,
    server,
    prodForwarding?.projectName ?? "",
  );

  try {
    await body({
      events: (predicate) => filterItems(server.events, predicate),
      payloads: (predicate) => filterItems(server.payloads, predicate),
      requestCursor: () => server.requests.length,
      requestsAfter: (after, predicate) =>
        normalizeCapturedRequests(
          filterItems(server.requests.slice(after), predicate),
        ),
      runDenoScenarioDir: (options) =>
        runDenoScenarioDir({
          ...options,
          env: {
            ...testEnv,
            ...(options.env ?? {}),
          },
        }),
      runNodeScenarioDir: (options) =>
        runNodeScenarioDir({
          ...options,
          env: {
            ...testEnv,
            ...(options.env ?? {}),
          },
        }),
      runScenarioDir: (options) =>
        runScenarioDir({
          ...options,
          env: {
            ...testEnv,
            ...(options.env ?? {}),
          },
        }),
      testRunEvents: (predicate) =>
        filterItems(
          server.events,
          (event) =>
            hasTestRunId(event.row, testRunId) &&
            (predicate ? predicate(event) : true),
        ),
      testRunId,
    });
  } finally {
    await server.close();
  }
}

export {
  installScenarioDependencies,
  isCanaryMode,
  prepareScenarioDir,
  readInstalledPackageVersion,
  type InstallScenarioDependenciesResult,
  type InstallScenarioDependenciesOptions,
};
