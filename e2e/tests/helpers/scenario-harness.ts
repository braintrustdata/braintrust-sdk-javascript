import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  startMockBraintrustServer,
  type CapturedLogEvent,
  type CapturedLogPayload,
  type CapturedRequest,
} from "./mock-braintrust-server";

export type EventPredicate = (event: CapturedLogEvent) => boolean;
export type PayloadPredicate = (payload: CapturedLogPayload) => boolean;
export type RequestPredicate = (request: CapturedRequest) => boolean;

export interface ScenarioResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const tsxCliPath = require.resolve("tsx/cli");
const packageRoot = process.cwd();
const DEFAULT_SCENARIO_TIMEOUT_MS = 15_000;

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

function createTestRunId(): string {
  return `e2e-${randomUUID()}`;
}

function getTestServerEnv(
  testRunId: string,
  server: { apiKey: string; url: string },
): Record<string, string> {
  return {
    BRAINTRUST_API_KEY: server.apiKey,
    BRAINTRUST_API_URL: server.url,
    BRAINTRUST_APP_URL: server.url,
    BRAINTRUST_APP_PUBLIC_URL: server.url,
    BRAINTRUST_PROXY_URL: server.url,
    BRAINTRUST_E2E_RUN_ID: testRunId,
  };
}

async function runProcess(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ScenarioResult> {
  return await new Promise<ScenarioResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: packageRoot,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`Process ${args.join(" ")} timed out after ${timeoutMs}ms`),
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

async function runScenarioOrThrow(
  relativeScenarioPath: string,
  env: Record<string, string>,
  options: {
    nodeArgs?: string[];
    timeoutMs?: number;
    useTsx?: boolean;
  } = {},
): Promise<ScenarioResult> {
  const scenarioPath = path.join(packageRoot, relativeScenarioPath);
  const args =
    options.useTsx === false
      ? [...(options.nodeArgs ?? []), scenarioPath]
      : [tsxCliPath, scenarioPath];
  const result = await runProcess(
    args,
    env,
    options.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Scenario ${relativeScenarioPath} failed with exit code ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  return result;
}

export interface ScenarioHarness {
  events: (predicate?: EventPredicate) => CapturedLogEvent[];
  payloads: (predicate?: PayloadPredicate) => CapturedLogPayload[];
  requestCursor: () => number;
  requestsAfter: (
    after: number,
    predicate?: RequestPredicate,
  ) => CapturedRequest[];
  runNodeScenario: (
    relativeScenarioPath: string,
    args?: string[],
    timeoutMs?: number,
  ) => Promise<ScenarioResult>;
  runScenario: (
    relativeScenarioPath: string,
    timeoutMs?: number,
  ) => Promise<ScenarioResult>;
  testRunEvents: (predicate?: EventPredicate) => CapturedLogEvent[];
  testRunId: string;
}

export async function withScenarioHarness(
  body: (harness: ScenarioHarness) => Promise<void>,
): Promise<void> {
  const server = await startMockBraintrustServer();
  const testRunId = createTestRunId();
  const testEnv = getTestServerEnv(testRunId, server);

  try {
    await body({
      events: (predicate) => filterItems(server.events, predicate),
      payloads: (predicate) => filterItems(server.payloads, predicate),
      requestCursor: () => server.requests.length,
      requestsAfter: (after, predicate) =>
        filterItems(server.requests.slice(after), predicate),
      runNodeScenario: (relativeScenarioPath, args = [], timeoutMs) =>
        runScenarioOrThrow(relativeScenarioPath, testEnv, {
          nodeArgs: args,
          timeoutMs,
          useTsx: false,
        }),
      runScenario: (relativeScenarioPath, timeoutMs) =>
        runScenarioOrThrow(relativeScenarioPath, testEnv, {
          timeoutMs,
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
