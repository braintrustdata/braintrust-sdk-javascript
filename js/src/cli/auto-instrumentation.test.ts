import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
  await fs.mkdir(path.join(googlePackageDir, "dist/node"), {
    recursive: true,
  });
  await fs.mkdir(indirectPackageDir, { recursive: true });

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
  ]);
}
