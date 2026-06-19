import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createCassetteServer,
  createJsonFileStore,
  type CassetteServerRoute,
  type FilterSpec,
  type RedactionSpec,
  type StreamingRequestMatcher,
} from "@braintrust/seinfeld";
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
const MISE_COMMAND = process.platform === "win32" ? "mise.exe" : "mise";
const DEFAULT_SCENARIO_TIMEOUT_MS = 15_000;
const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HELPERS_DIR, "../..");
const RUN_CONTEXT_DIR_ENV = "BRAINTRUST_E2E_RUN_CONTEXT_DIR";
const CASSETTE_MODE_ENV = "BRAINTRUST_E2E_CASSETTE_MODE";
const DEFAULT_ANTHROPIC_BEDROCK_REGION = "us-east-1";

type ScenarioRunner = "deno" | "node" | "tsx";

export interface ScenarioCassetteConfig {
  /**
   * Identifier for the cassette filename (without .cassette.json suffix).
   * Defaults to `runContext.variantKey ?? "default"`.
   */
  variantKey?: string;
}

export interface ScenarioRunContext {
  variantKey?: string;
  /**
   * Opt the scenario into the cassette layer. Pass `true` to enable with
   * default settings, an object to override, or `false` to opt out. Provider
   * scenarios usually only need `variantKey`; the harness engages the
   * cassette layer for variant-backed runs and writes cassettes back to the
   * original scenario folder, even when scenarios run from a temp
   * `prepareScenarioDir` copy.
   */
  cassette?: boolean | ScenarioCassetteConfig;
  /**
   * Original (committed) scenario folder that owns the `__cassettes__/`
   * directory. Required when `cassette` is set and scenarios run from a
   * `prepareScenarioDir` temp copy. If the test is calling the harness
   * directly without `prepareScenarioDir`, this can usually be left
   * undefined and the scenario folder defaults to the temp dir.
   */
  originalScenarioDir?: string;
}

interface ScenarioRunContextRecord {
  entry: string;
  runner: ScenarioRunner;
  scenarioDirName: string;
  testRunId: string;
  timestamp: string;
  variantKey?: string;
}

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

function getRunContextDir(): string | null {
  const runContextDir = process.env[RUN_CONTEXT_DIR_ENV]?.trim();
  if (!runContextDir) {
    return null;
  }
  return runContextDir;
}

async function recordScenarioRunContext(
  record: ScenarioRunContextRecord,
): Promise<void> {
  const runContextDir = getRunContextDir();
  if (!runContextDir) {
    return;
  }

  await mkdir(runContextDir, { recursive: true });
  const recordPath = path.join(
    runContextDir,
    `run-context-${process.pid}.ndjson`,
  );
  await appendFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
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

interface CassetteWiring {
  cassetteDir: string;
  mode: "replay" | "record" | "passthrough";
  originalScenarioDir: string;
  replayPlaceholders: boolean;
  variantKey: string;
}

interface ActiveCassetteWiring extends CassetteWiring {
  serverUrl: string;
}

function getAnthropicBedrockRegion(): string {
  return (
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    DEFAULT_ANTHROPIC_BEDROCK_REGION
  );
}

function getCassetteServerRoutes(): CassetteServerRoute[] {
  return [
    { prefix: "/anthropic", upstreamOrigin: "https://api.anthropic.com" },
    {
      prefix: "/anthropic-bedrock",
      upstreamOrigin: `https://bedrock-runtime.${getAnthropicBedrockRegion()}.amazonaws.com`,
    },
    { prefix: "/cohere", upstreamOrigin: "https://api.cohere.com" },
    { prefix: "/cursor/v1", upstreamOrigin: "https://api.cursor.com/v1" },
    { prefix: "/cursor", upstreamOrigin: "https://api2.cursor.sh" },
    {
      prefix: "/google-generative-language",
      upstreamOrigin: "https://generativelanguage.googleapis.com",
    },
    { prefix: "/groq", upstreamOrigin: "https://api.groq.com" },
    { prefix: "/huggingface", upstreamOrigin: "https://huggingface.co" },
    {
      prefix: "/huggingface-router",
      upstreamOrigin: "https://router.huggingface.co",
    },
    { prefix: "/mistral", upstreamOrigin: "https://api.mistral.ai" },
    { prefix: "/openai", upstreamOrigin: "https://api.openai.com" },
    { prefix: "/openrouter", upstreamOrigin: "https://openrouter.ai" },
  ];
}

const CASSETTE_IGNORED_REQUESTS = [
  /^https:\/\/api2\.cursor\.sh\/aiserver\.v1\.AnalyticsService\/TrackEvents$/,
];

function getCassetteEnv(wiring: ActiveCassetteWiring): Record<string, string> {
  const serverUrl = wiring.serverUrl;
  return {
    BRAINTRUST_E2E_CASSETTE_PATH: wiring.cassetteDir,
    BRAINTRUST_E2E_CASSETTE_MODE: wiring.mode,
    BRAINTRUST_E2E_CASSETTE_SERVER_URL: serverUrl,
    BRAINTRUST_E2E_CASSETTE_VARIANT: wiring.variantKey,
    BRAINTRUST_E2E_MODEL_BASE_URL: `${serverUrl}/openai/v1`,
    ANTHROPIC_BASE_URL: `${serverUrl}/anthropic`,
    ANTHROPIC_BEDROCK_BASE_URL: `${serverUrl}/anthropic-bedrock`,
    COHERE_BASE_URL: `${serverUrl}/cohere`,
    COHERE_API_URL: `${serverUrl}/cohere`,
    CURSOR_BACKEND_URL: `${serverUrl}/cursor`,
    GEMINI_BASE_URL: `${serverUrl}/google-generative-language`,
    GEMINI_NEXT_GEN_API_BASE_URL: `${serverUrl}/google-generative-language`,
    GOOGLE_GENERATIVE_AI_BASE_URL: `${serverUrl}/google-generative-language`,
    GOOGLE_GENAI_BASE_URL: `${serverUrl}/google-generative-language`,
    GROQ_BASE_URL: `${serverUrl}/groq`,
    HF_ENDPOINT: `${serverUrl}/huggingface`,
    HF_INFERENCE_ENDPOINT: `${serverUrl}/huggingface-router`,
    HUGGINGFACE_BASE_URL: `${serverUrl}/huggingface`,
    HUGGINGFACE_ROUTER_BASE_URL: `${serverUrl}/huggingface-router`,
    MISTRAL_API_URL: `${serverUrl}/mistral`,
    MISTRAL_BASE_URL: `${serverUrl}/mistral`,
    OPENAI_BASE_URL: `${serverUrl}/openai/v1`,
    OPENROUTER_BASE_URL: `${serverUrl}/openrouter/api/v1`,
  };
}

/**
 * Many provider SDKs (Anthropic, Cohere, OpenAI, Google ...) validate the
 * presence of an API key at client-construction time, before any HTTP
 * request is made. When the cassette layer replays from disk, no real key
 * is needed — but the SDK still throws if the env var is unset. Inject
 * placeholder values so SDK construction succeeds; the cassette layer
 * intercepts the outgoing fetch and replays from disk.
 *
 * Real keys (when set) take precedence so recording and live debugging
 * still hit the real APIs.
 *
 * Some SDKs honor multiple env vars for the same provider (e.g. the
 * Google GenAI SDK reads `GOOGLE_API_KEY` first and falls back to
 * `GEMINI_API_KEY`). When the developer has set the *fallback* var to a
 * real key, we must NOT inject a placeholder for the preferred var —
 * doing so silently overrides the real key with a fake one and the API
 * rejects the request as `API_KEY_INVALID`. Group such vars so the
 * placeholder injection skips the whole group when any member has a
 * real value.
 */
const CASSETTE_PROVIDER_KEYS: Array<{
  envVars: string[];
  placeholder: string;
}> = [
  {
    envVars: ["ANTHROPIC_API_KEY"],
    placeholder: "sk-ant-cassette-placeholder",
  },
  {
    envVars: ["AWS_BEARER_TOKEN_BEDROCK"],
    placeholder: "cassette-placeholder",
  },
  {
    envVars: ["COHERE_API_KEY", "CO_API_KEY"],
    placeholder: "cassette-placeholder",
  },
  { envVars: ["CURSOR_API_KEY"], placeholder: "key_cassette-placeholder" },
  {
    envVars: ["GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "GEMINI_API_KEY"],
    placeholder: "cassette-placeholder",
  },
  { envVars: ["GROQ_API_KEY"], placeholder: "gsk_cassette-placeholder" },
  { envVars: ["HUGGINGFACE_API_KEY"], placeholder: "hf_cassette-placeholder" },
  { envVars: ["MISTRAL_API_KEY"], placeholder: "cassette-placeholder" },
  { envVars: ["OPENAI_API_KEY"], placeholder: "sk-cassette-placeholder" },
  {
    envVars: ["OPENROUTER_API_KEY"],
    placeholder: "sk-or-cassette-placeholder",
  },
];

function getProviderKeyPlaceholders(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { envVars, placeholder } of CASSETTE_PROVIDER_KEYS) {
    const anyRealValueSet = envVars.some((key) => Boolean(process.env[key]));
    if (anyRealValueSet) continue;
    // Inject the placeholder for every var in the group so SDKs that
    // pick the first non-empty one all see a value.
    for (const key of envVars) {
      env[key] = placeholder;
    }
  }
  return env;
}

function resolveCassetteMode(
  raw: string | undefined,
): "replay" | "record" | "passthrough" {
  if (raw === "record" || raw === "record-missing") return "record";
  if (raw === "passthrough") return "passthrough";
  return "replay";
}

async function loadScenarioCassetteOptions(scenarioDir: string): Promise<{
  filter: FilterSpec | undefined;
  redact: RedactionSpec | undefined;
  streamingRequests: StreamingRequestMatcher[] | undefined;
}> {
  const filterPath = path.join(scenarioDir, "cassette-filter.mjs");
  if (!existsSync(filterPath)) {
    return {
      filter: "default",
      redact: undefined,
      streamingRequests: undefined,
    };
  }
  const mod = (await import(pathToFileURL(filterPath).href)) as {
    filter?: FilterSpec;
    redact?: RedactionSpec;
    streamingRequests?: StreamingRequestMatcher[];
  };
  return {
    filter: mod.filter ?? "default",
    redact: mod.redact,
    streamingRequests: mod.streamingRequests,
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

function isSpawnEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function runDenoProcess(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ScenarioResult> {
  try {
    return await runProcess(DENO_COMMAND, args, cwd, env, timeoutMs);
  } catch (error) {
    if (!isSpawnEnoent(error)) {
      throw error;
    }

    return await runProcess(
      MISE_COMMAND,
      ["exec", "--", "deno", ...args],
      cwd,
      env,
      timeoutMs,
    );
  }
}

function resolveEntryPath(scenarioDir: string, entry: string): string {
  return path.join(scenarioDir, entry);
}

export function effectiveScenarioTimeoutMs(
  timeoutMs: number | undefined,
): number {
  const base = timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
  // In record / record-missing mode the cassette layer retries with
  // exponential backoff against transient provider failures (429/5xx),
  // which can multiply scenario wall time. Triple the timeout so the
  // recording has headroom — replay mode still uses the original budget.
  const mode = process.env[CASSETTE_MODE_ENV];
  if (mode === "record" || mode === "record-missing") {
    return base * 3;
  }
  return base;
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

  let args: string[];
  if (options.useTsx === false) {
    args = [...(options.nodeArgs ?? []), scenarioPath];
  } else {
    args = [tsxCliPath, scenarioPath];
  }

  const result = await runProcess(
    process.execPath,
    args,
    scenarioDir,
    env,
    effectiveScenarioTimeoutMs(options.timeoutMs),
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
  runContext?: ScenarioRunContext;
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
  runContext?: ScenarioRunContext;
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
  runContext?: ScenarioRunContext;
  scenarioDir: string;
  timeoutMs?: number;
}): Promise<ScenarioResult> {
  const entry = options.entry ?? "runner.case.ts";
  const result = await runDenoProcess(
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
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs?: number;
  }) => Promise<ScenarioResult>;
  runNodeScenarioDir: (options: {
    entry?: string;
    env?: Record<string, string>;
    nodeArgs?: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs?: number;
  }) => Promise<ScenarioResult>;
  runScenarioDir: (options: {
    entry?: string;
    env?: Record<string, string>;
    runContext?: ScenarioRunContext;
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

  const cassetteModeRaw = process.env[CASSETTE_MODE_ENV];
  const cassetteMode = resolveCassetteMode(cassetteModeRaw);
  const isRecordingMode =
    cassetteModeRaw === "record" || cassetteModeRaw === "record-missing";

  const cassetteWiringFor = (options: {
    runContext?: ScenarioRunContext;
    scenarioDir: string;
  }): CassetteWiring | null => {
    const cassetteOpt = options.runContext?.cassette;
    if (cassetteOpt === false) {
      return null;
    }
    const config: ScenarioCassetteConfig =
      typeof cassetteOpt === "object" ? cassetteOpt : {};
    const variantKey =
      config.variantKey ?? options.runContext?.variantKey ?? "default";
    const originalScenarioDir =
      options.runContext?.originalScenarioDir ?? options.scenarioDir;
    const cassettePath = path.join(
      originalScenarioDir,
      "__cassettes__",
      `${variantKey}.cassette.json`,
    );

    // Auto-engage the cassette layer when:
    // - the test explicitly opted in via `runContext.cassette === true`, OR
    // - the run has a variant key (provider scenarios should fail loudly on
    //   cassette misses instead of skipping or falling back to live APIs), OR
    // - a cassette file already exists for this variant (so replay just
    //   works without each scenario opting in by hand), OR
    // - we're in record mode (the developer is actively recording new fixtures).
    const explicitOptIn =
      cassetteOpt === true || typeof cassetteOpt === "object";
    const hasVariantKey = options.runContext?.variantKey !== undefined;
    const fileExists = existsSync(cassettePath);
    if (!explicitOptIn && !hasVariantKey && !fileExists && !isRecordingMode) {
      return null;
    }

    const isReplayMode = !isRecordingMode && cassetteModeRaw !== "passthrough";

    return {
      cassetteDir: path.dirname(cassettePath),
      mode: cassetteMode,
      originalScenarioDir,
      replayPlaceholders: isReplayMode,
      variantKey,
    };
  };

  const runWithCassetteServer = async (
    options: {
      entry?: string;
      env?: Record<string, string>;
      runContext?: ScenarioRunContext;
      scenarioDir: string;
    },
    run: (cassetteEnv: Record<string, string>) => Promise<ScenarioResult>,
  ): Promise<ScenarioResult> => {
    const wiring = cassetteWiringFor(options);
    if (!wiring) {
      return await run({});
    }

    const cassetteOptions = await loadScenarioCassetteOptions(
      wiring.originalScenarioDir,
    );
    const cassetteServer = createCassetteServer({
      name: wiring.variantKey,
      mode: wiring.mode,
      store: createJsonFileStore({ rootDir: wiring.cassetteDir }),
      filters: cassetteOptions.filter,
      redact: cassetteOptions.redact,
      streamingRequests: cassetteOptions.streamingRequests,
      ignoredRequests: CASSETTE_IGNORED_REQUESTS,
      routes: getCassetteServerRoutes(),
      onMiss: (req) => {
        process.stderr.write(`[cassette] MISS: ${req.method} ${req.url}\n`);
      },
    });

    await cassetteServer.start();
    let result: ScenarioResult | undefined;
    let runError: unknown;
    try {
      result = await run({
        // Only inject placeholder keys in replay mode. In record/passthrough
        // mode the subprocess needs real provider keys to make live API calls.
        ...(wiring.replayPlaceholders ? getProviderKeyPlaceholders() : {}),
        ...getCassetteEnv({ ...wiring, serverUrl: cassetteServer.url }),
      });
    } catch (err) {
      runError = err;
    }

    try {
      await cassetteServer.stop();
    } catch (stopError) {
      if (!runError) throw stopError;
    }

    if (runError) throw runError;
    return result!;
  };

  const runWithContext = async (
    options: {
      entry?: string;
      runContext?: ScenarioRunContext;
      scenarioDir: string;
    },
    runner: ScenarioRunner,
    defaultEntry: string,
    run: () => Promise<ScenarioResult>,
  ): Promise<ScenarioResult> => {
    const result = await run();
    await recordScenarioRunContext({
      entry: options.entry ?? defaultEntry,
      runner,
      scenarioDirName: path.basename(options.scenarioDir),
      testRunId,
      timestamp: new Date().toISOString(),
      variantKey: options.runContext?.variantKey,
    });
    return result;
  };

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
        runWithContext(options, "deno", "runner.case.ts", async () =>
          runDenoScenarioDir({
            ...options,
            env: {
              ...testEnv,
              ...(options.env ?? {}),
            },
          }),
        ),
      runNodeScenarioDir: (options) =>
        runWithContext(options, "node", "scenario.mjs", async () =>
          runWithCassetteServer(options, (cassetteEnv) =>
            runNodeScenarioDir({
              ...options,
              env: {
                ...testEnv,
                ...cassetteEnv,
                ...(options.env ?? {}),
              },
            }),
          ),
        ),
      runScenarioDir: (options) =>
        runWithContext(options, "tsx", "scenario.ts", async () =>
          runWithCassetteServer(options, (cassetteEnv) =>
            runScenarioDir({
              ...options,
              env: {
                ...testEnv,
                ...cassetteEnv,
                ...(options.env ?? {}),
              },
            }),
          ),
        ),
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
