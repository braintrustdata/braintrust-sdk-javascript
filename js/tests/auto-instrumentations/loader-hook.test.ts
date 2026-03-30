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

interface TestResult {
  events: { start: any[]; end: any[]; error: any[] };
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
  });
});

async function runWithWorker(options: {
  execArgv: string[];
  script: string;
}): Promise<TestResult> {
  return runWithWorkerMessage({
    ...options,
    messageType: "events",
  });
}

async function runWithWorkerMessage<T>(options: {
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
      env: { ...process.env, NODE_OPTIONS: "" },
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
