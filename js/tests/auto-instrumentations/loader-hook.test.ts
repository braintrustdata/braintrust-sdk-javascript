import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

// Path to unified loader hook (built dist file)
const hookPath = path.join(
  __dirname,
  "../../dist/auto-instrumentations/hook.mjs",
);

// Paths to fixtures
const listenerPath = path.join(fixturesDir, "listener-esm.mjs");
const testAppEsmPath = path.join(fixturesDir, "test-app-esm.mjs");
const testAppCjsPath = path.join(fixturesDir, "test-app-cjs.cjs");
const helperPromisePath = path.join(
  fixturesDir,
  "test-api-promise-preservation.mjs",
);
const importHookQueryModePath = path.join(
  fixturesDir,
  "import-hook-query-mode.mjs",
);
const runtimeApplyAutoSideEffectEsmPath = path.join(
  fixturesDir,
  "runtime-apply-auto-side-effect-esm.mjs",
);
const runtimeApplyAutoSideEffectCjsPath = path.join(
  fixturesDir,
  "runtime-apply-auto-side-effect-cjs.cjs",
);
const mastraTopLevelEsmPath = path.join(
  fixturesDir,
  "test-mastra-top-level-esm.mjs",
);
const mastraTopLevelCjsPath = path.join(
  fixturesDir,
  "test-mastra-top-level-cjs.cjs",
);
const runtimeApplyAutoMastraTopLevelEsmPath = path.join(
  fixturesDir,
  "runtime-apply-auto-mastra-top-level-esm.mjs",
);

interface TestResult {
  events: { start: any[]; end: any[]; error: any[] };
}

interface MastraResult {
  root: { exporters: string[]; hasObservability: boolean };
  subpath: { exporters: string[]; hasObservability: boolean };
  userConfig: {
    custom: string;
    configs: {
      default: { exporters: { name: string }[]; serviceName: string };
    };
  };
  userObservabilityPreserved: boolean;
}

describe("Unified Loader Hook Integration Tests", () => {
  beforeAll(() => {
    // No setup needed - test/fixtures/node_modules/openai is committed to the repo
  });

  afterAll(() => {
    // No cleanup needed - we don't create any temporary files
  });

  describe("Unified hook (--import) handles both ESM and CJS", () => {
    it("should emit diagnostics_channel events for ESM OpenAI calls", async () => {
      const result = await runWithWorker({
        execArgv: ["--import", listenerPath, "--import", hookPath],
        script: testAppEsmPath,
      });

      expect(result.events.start.length).toBeGreaterThan(0);
      expect(result.events.end.length).toBeGreaterThan(0);
      expect(result.events.start[0].args).toBeDefined();
    });

    it("should emit diagnostics_channel events for CJS OpenAI calls", async () => {
      const result = await runWithWorker({
        execArgv: ["--import", listenerPath, "--import", hookPath],
        script: testAppCjsPath,
      });

      expect(result.events.start.length).toBeGreaterThan(0);
      expect(result.events.end.length).toBeGreaterThan(0);
    });

    it("should preserve helper methods on promise subclasses", async () => {
      const result = await runWithWorkerMessage<{
        awaitedValue: string;
        constructorName: string;
        hasWithResponse: boolean;
        withResponseData: string;
        withResponseOk: boolean;
      }>({
        execArgv: ["--import", hookPath],
        messageType: "helper-result",
        script: helperPromisePath,
      });

      expect(result.hasWithResponse).toBe(true);
      expect(result.awaitedValue).toBe("ok");
      expect(result.withResponseData).toBe("ok");
      expect(result.withResponseOk).toBe(true);
      expect(result.constructorName).toBe("HelperPromise");
    });

    it("should expose import hook exports in query mode without bootstrapping", async () => {
      const result = await runWithWorkerMessage<{
        applied: boolean;
        hasInitialize: boolean;
        hasLoad: boolean;
        hasRegister: boolean;
        hasResolve: boolean;
      }>({
        env: {
          BRAINTRUST_QUERY_HOOK_URL: `${pathToFileURL(hookPath).href}?braintrust-iitm-loader=true`,
        },
        execArgv: [],
        messageType: "hook-query-result",
        script: importHookQueryModePath,
      });

      expect(result).toEqual({
        applied: false,
        hasInitialize: true,
        hasLoad: true,
        hasRegister: true,
        hasResolve: true,
      });
    });

    it("should patch Mastra ESM exports", async () => {
      const result = await runWithWorkerMessage<MastraResult>({
        execArgv: ["--import", hookPath],
        messageType: "mastra-result",
        script: mastraTopLevelEsmPath,
      });

      expectMastraEnabled(result);
    });

    it("should leave Mastra constructor channels passive until Braintrust enables its plugins", async () => {
      const result = await runWithWorkerMessage<MastraResult>({
        env: { BRAINTRUST_TEST_ENABLE_MASTRA_PLUGIN: "false" },
        execArgv: ["--import", hookPath],
        messageType: "mastra-result",
        script: mastraTopLevelEsmPath,
      });

      expect(result.root).toEqual({ exporters: [], hasObservability: false });
      expect(result.subpath).toEqual({
        exporters: [],
        hasObservability: false,
      });
      expect(result.userObservabilityPreserved).toBe(true);
      expect(
        result.userConfig.configs.default.exporters.map(
          (exporter) => exporter.name,
        ),
      ).toEqual(["other"]);
    });

    it("should patch Mastra CJS exports", async () => {
      const result = await runWithWorkerMessage<MastraResult>({
        execArgv: ["--import", hookPath],
        messageType: "mastra-result",
        script: mastraTopLevelCjsPath,
      });

      expectMastraEnabled(result);
    });

    it("should respect Mastra disable config for module export hooks", async () => {
      const result = await runWithWorkerMessage<MastraResult>({
        env: { BRAINTRUST_DISABLE_INSTRUMENTATION: "mastra" },
        execArgv: ["--import", hookPath],
        messageType: "mastra-result",
        script: mastraTopLevelEsmPath,
      });

      expect(result.root).toEqual({ exporters: [], hasObservability: false });
      expect(result.subpath).toEqual({
        exporters: [],
        hasObservability: false,
      });
      expect(result.userObservabilityPreserved).toBe(true);
      expect(
        result.userConfig.configs.default.exporters.map(
          (exporter) => exporter.name,
        ),
      ).toEqual(["other"]);
    });
  });

  describe("apply-auto-instrumentation side-effect runtime setup", () => {
    it("should apply instrumentation through the side-effect ESM export", async () => {
      const result = await runWithWorker({
        execArgv: ["--import", listenerPath],
        script: runtimeApplyAutoSideEffectEsmPath,
      });

      expect(result.events.start.length).toBe(1);
      expect(result.events.end.length).toBe(1);
    });

    it("should apply instrumentation through the side-effect CJS export", async () => {
      const result = await runWithWorker({
        execArgv: ["--import", listenerPath],
        script: runtimeApplyAutoSideEffectCjsPath,
      });

      expect(result.events.start.length).toBe(1);
      expect(result.events.end.length).toBe(1);
    });

    it("should respect BRAINTRUST_DISABLE_INSTRUMENTATION", async () => {
      const result = await runWithWorker({
        env: { BRAINTRUST_DISABLE_INSTRUMENTATION: "openai" },
        execArgv: ["--import", listenerPath],
        script: runtimeApplyAutoSideEffectEsmPath,
      });

      expect(result.events.start.length).toBe(0);
      expect(result.events.end.length).toBe(0);
    });

    it("should not double-apply when import hook and side-effect export both run", async () => {
      const result = await runWithWorker({
        execArgv: ["--import", listenerPath, "--import", hookPath],
        script: runtimeApplyAutoSideEffectEsmPath,
      });

      expect(result.events.start.length).toBe(1);
      expect(result.events.end.length).toBe(1);
    });

    it("should apply Mastra patches through the side-effect export", async () => {
      const result = await runWithWorkerMessage<MastraResult>({
        execArgv: [],
        messageType: "mastra-result",
        script: runtimeApplyAutoMastraTopLevelEsmPath,
      });

      expectMastraEnabled(result);
    });
  });
});

function expectMastraEnabled(result: MastraResult): void {
  expect(result.root).toEqual({
    exporters: ["braintrust"],
    hasObservability: true,
  });
  expect(result.subpath).toEqual({
    exporters: ["braintrust"],
    hasObservability: true,
  });
  expect(result.userObservabilityPreserved).toBe(true);
  expect(result.userConfig.custom).toBe("kept");
  expect(result.userConfig.configs.default.serviceName).toBe("user-service");
  expect(
    result.userConfig.configs.default.exporters.map(
      (exporter) => exporter.name,
    ),
  ).toEqual(["other", "braintrust"]);
}

async function runWithWorker(options: {
  env?: NodeJS.ProcessEnv;
  execArgv: string[];
  script: string;
}): Promise<TestResult> {
  return runWithWorkerMessage({
    ...options,
    messageType: "events",
  });
}

async function runWithWorkerMessage<T>(options: {
  env?: NodeJS.ProcessEnv;
  execArgv: string[];
  messageType: string;
  script: string;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T | null = null;

    // Convert execArgv paths to file URLs on Windows
    // On Windows, Node.js --import requires file:// URLs
    const execArgv =
      process.platform === "win32"
        ? options.execArgv.map((arg, index) => {
            // If this is a path argument after --import, convert to file URL
            const prevArg = index > 0 ? options.execArgv[index - 1] : null;
            if (
              prevArg === "--import" &&
              !arg.startsWith("file://") &&
              !arg.startsWith("node:")
            ) {
              return pathToFileURL(path.resolve(arg)).href;
            }
            return arg;
          })
        : options.execArgv;

    // Convert script path to URL on Windows for Worker constructor
    // On Windows, Worker constructor requires URL objects for file:// URLs
    const scriptUrl =
      process.platform === "win32" && !options.script.startsWith("file://")
        ? pathToFileURL(path.resolve(options.script))
        : options.script;

    const worker = new Worker(scriptUrl, {
      execArgv,
      env: { ...process.env, ...options.env, NODE_OPTIONS: "" },
    });

    worker.on("message", (msg) => {
      if (msg.type === options.messageType) {
        result = (msg.result ?? { events: msg.events }) as T;
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Worker exited with code ${code}`));
      } else if (result) {
        resolve(result);
      } else {
        reject(new Error("No events received from worker"));
      }
    });
  });
}
