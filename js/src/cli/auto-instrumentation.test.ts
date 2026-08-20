import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { newGlobalTracingChannel } from "../global-instrumentation-hooks";
import { initializeHandles } from "./index";
import type { FileHandle } from "./types";

vi.mock("./functions/load-module", () => ({
  loadModule: () => ({
    evaluators: {},
    functions: [],
    parameters: [],
    prompts: [],
    reporters: {},
  }),
}));

const googleGenAIChannel = "orchestrion:@google/genai:models.generateContent";
const anthropicChannel = "orchestrion:@anthropic-ai/sdk:messages.create";
const execFileAsync = promisify(execFile);
const loadModulePath = fileURLToPath(
  new URL("./functions/load-module.ts", import.meta.url),
);
const globalHooksPath = fileURLToPath(
  new URL("../global-instrumentation-hooks.ts", import.meta.url),
);
const debugLoggerPath = fileURLToPath(
  new URL("../debug-logger.ts", import.meta.url),
);

describe("eval auto-instrumentation", () => {
  let fixtureDir: string;
  let handles: Record<string, FileHandle> = {};

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "braintrust-eval-instrumentation-"),
    );
    await writeFixturePackages(fixtureDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(Object.values(handles).map((handle) => handle.destroy()));
    await Promise.all(
      [
        ...new Set(
          Object.values(handles)
            .map((handle) => handle.bundleFile)
            .filter(
              (bundleFile): bundleFile is string => bundleFile !== undefined,
            )
            .map((bundleFile) => path.dirname(bundleFile)),
        ),
      ].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
    handles = {};
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it.each([
    [
      "directly",
      `export { Models } from "@google/genai";`,
      (exports: Record<string, unknown>) => {
        const Models = exports.Models as new () => {
          generateContentInternal(input: string): Promise<{ text: string }>;
        };
        return new Models().generateContentInternal("payload");
      },
    ],
    [
      "through a dependency",
      `export { invoke } from "google-genai-client";`,
      (exports: Record<string, unknown>) =>
        (exports.invoke as (input: string) => Promise<{ text: string }>)(
          "payload",
        ),
    ],
  ])(
    "instruments @google/genai when imported %s",
    async (_label, source, invoke) => {
      const output = await buildEval(fixtureDir, source);

      expect(output).toContain(googleGenAIChannel);

      const lifecycle: string[] = [];
      const hook = newGlobalTracingChannel(googleGenAIChannel);
      const handlers = {
        asyncEnd: () => lifecycle.push("asyncEnd"),
        asyncStart: () => lifecycle.push("asyncStart"),
        end: () => lifecycle.push("end"),
        start: () => lifecycle.push("start"),
      };
      hook.subscribe(handlers);

      try {
        const loadedModule = { exports: {} as Record<string, unknown> };
        Function(
          "module",
          "exports",
          output,
        )(loadedModule, loadedModule.exports);

        await expect(invoke(loadedModule.exports)).resolves.toEqual({
          text: "payload",
        });
        expect(lifecycle).toEqual(["start", "end", "asyncStart", "asyncEnd"]);
      } finally {
        hook.unsubscribe(handlers);
      }
    },
  );

  it("respects BRAINTRUST_DISABLE_INSTRUMENTATION", async () => {
    vi.stubEnv("BRAINTRUST_DISABLE_INSTRUMENTATION", "google-genai");

    const output = await buildEval(
      fixtureDir,
      `export { Models } from "@google/genai";`,
    );

    expect(output).not.toContain(googleGenAIChannel);
  });

  it("instruments the final uploaded bundle", async () => {
    await buildEval(fixtureDir, `export { Models } from "@google/genai";`);

    await handles[path.join(fixtureDir, "instrumentation.eval.ts")].bundle();
    const output = await fs.readFile(
      handles[path.join(fixtureDir, "instrumentation.eval.ts")].bundleFile!,
      "utf8",
    );

    expect(output).toContain(googleGenAIChannel);
  });

  it.each([
    ["instruments", undefined, ["start", "end", "asyncStart", "asyncEnd"]],
    ["respects opt-out for", "anthropic", []],
  ])("%s external eval dependencies", async (_label, disabled, expected) => {
    const runnerPath = path.join(fixtureDir, "external-eval-runner.cjs");
    const evalFile = path.join(fixtureDir, "external.eval.ts");
    await fs.writeFile(evalFile, "");
    await fs.writeFile(
      runnerPath,
      `require("tsx/cjs");
require("node:module").register = () => {};
const { loadModule } = require(${JSON.stringify(loadModulePath)});
const { newGlobalTracingChannel } = require(${JSON.stringify(globalHooksPath)});
const lifecycle = [];
const channel = newGlobalTracingChannel(${JSON.stringify(anthropicChannel)});
const handlers = Object.fromEntries(
  ["start", "end", "asyncStart", "asyncEnd"].map((name) => [name, () => lifecycle.push(name)]),
);
channel.subscribe(handlers);
loadModule({
  inFile: ${JSON.stringify(evalFile)},
  moduleText: 'const { Messages } = require("@anthropic-ai/sdk/resources/messages/messages.js"); globalThis.__externalEvalResult = new Messages().create("payload");',
});
Promise.resolve(globalThis.__externalEvalResult).then((result) => {
  channel.unsubscribe(handlers);
  process.stdout.write(JSON.stringify({ lifecycle, result }));
});`,
    );

    const env = { ...process.env };
    if (disabled) {
      env.BRAINTRUST_DISABLE_INSTRUMENTATION = disabled;
    } else {
      delete env.BRAINTRUST_DISABLE_INSTRUMENTATION;
    }
    const { stdout } = await execFileAsync(process.execPath, [runnerPath], {
      env,
    });

    expect(JSON.parse(stdout)).toEqual({
      lifecycle: expected,
      result: { text: "payload" },
    });
  });

  it("reports unexpected runtime instrumentation failures", async () => {
    const runnerPath = path.join(
      fixtureDir,
      "failed-instrumentation-runner.cjs",
    );
    const evalFile = path.join(fixtureDir, "failed-instrumentation.eval.ts");
    await fs.writeFile(evalFile, "");
    await fs.writeFile(
      runnerPath,
      `require("tsx/cjs");
require("node:module").register = () => { throw new Error("setup failed"); };
require(${JSON.stringify(debugLoggerPath)}).setGlobalDebugLogLevel("warn");
const { loadModule } = require(${JSON.stringify(loadModulePath)});
loadModule({ inFile: ${JSON.stringify(evalFile)}, moduleText: "" });
process.stdout.write("loaded");`,
    );

    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      [runnerPath],
      {
        env: { ...process.env, BRAINTRUST_DEBUG_LOG_LEVEL: "warn" },
      },
    );

    expect(stdout).toBe("loaded");
    expect(stderr).toContain(
      "Failed to enable auto-instrumentation for external eval dependencies",
    );
    expect(stderr).toContain("setup failed");
  });

  async function buildEval(fixtureDir: string, source: string) {
    const evalFile = path.join(fixtureDir, "instrumentation.eval.ts");
    await fs.writeFile(evalFile, source);
    handles = await initializeHandles({ files: [evalFile], mode: "eval" });

    const result = await handles[evalFile].rebuild();
    if (result.type !== "success") {
      throw result.error;
    }

    return result.result.outputFiles?.[0].text ?? "";
  }
});

async function writeFixturePackages(fixtureDir: string) {
  const googlePackageDir = path.join(fixtureDir, "node_modules/@google/genai");
  const indirectPackageDir = path.join(
    fixtureDir,
    "node_modules/google-genai-client",
  );
  const anthropicPackageDir = path.join(
    fixtureDir,
    "node_modules/@anthropic-ai/sdk",
  );
  await fs.mkdir(path.join(googlePackageDir, "dist/node"), {
    recursive: true,
  });
  await fs.mkdir(indirectPackageDir, { recursive: true });
  await fs.mkdir(path.join(anthropicPackageDir, "resources/messages"), {
    recursive: true,
  });

  await Promise.all([
    fs.writeFile(
      path.join(googlePackageDir, "package.json"),
      JSON.stringify({
        name: "@google/genai",
        version: "1.50.0",
        type: "module",
        exports: "./dist/node/index.mjs",
      }),
    ),
    fs.writeFile(
      path.join(googlePackageDir, "dist/node/index.mjs"),
      `export class Models {
        async generateContentInternal(input) {
          return { text: input };
        }
      }`,
    ),
    fs.writeFile(
      path.join(indirectPackageDir, "package.json"),
      JSON.stringify({
        name: "google-genai-client",
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      }),
    ),
    fs.writeFile(
      path.join(indirectPackageDir, "index.mjs"),
      `import { Models } from "@google/genai";
      export function invoke(input) {
        return new Models().generateContentInternal(input);
      }`,
    ),
    fs.writeFile(
      path.join(anthropicPackageDir, "package.json"),
      JSON.stringify({
        name: "@anthropic-ai/sdk",
        version: "0.60.0",
        exports: {
          "./resources/messages/messages.js":
            "./resources/messages/messages.js",
        },
      }),
    ),
    fs.writeFile(
      path.join(anthropicPackageDir, "resources/messages/messages.js"),
      `class Messages {
        async create(input) {
          return { text: input };
        }
      }
      module.exports = { Messages };`,
    ),
  ]);
}
