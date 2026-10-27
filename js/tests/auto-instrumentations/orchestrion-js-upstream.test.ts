/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SourceMapConsumer } from "source-map";
import {
  InstrumentationMatcher,
  type InstrumentationConfig,
} from "../../src/auto-instrumentations/orchestrion-js";
import { buildTestGlobalHookRuntime } from "./test-global-hook-runtime";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(__dirname, "fixtures/orchestrion-js");

const TEST_MODULE_NAME = "undici";
const TEST_MODULE_VERSION = "0.0.1";
const TEST_MODULE_PATH = "index.mjs";
const WINDOWS_MODULE_PATH = "lib/index.mjs";

interface UpstreamFixtureCase {
  name: string;
  title: string;
  configs: InstrumentationConfig[];
  mjs?: boolean;
  filePath?: string;
  transformerFilePath?: string;
}

let outputRoot: string;
let globalHookRuntimePath: string;

function config(
  channelName: string,
  functionQuery: InstrumentationConfig["functionQuery"],
  filePath = TEST_MODULE_PATH,
): InstrumentationConfig {
  return {
    channelName,
    module: {
      name: TEST_MODULE_NAME,
      versionRange: ">=0.0.1",
      filePath,
    },
    functionQuery,
  };
}

function runFixture({
  name,
  configs,
  mjs = false,
  filePath = TEST_MODULE_PATH,
  transformerFilePath = filePath,
}: UpstreamFixtureCase): void {
  const ext = mjs ? "mjs" : "js";
  const sourceDir = path.join(fixtureRoot, name);
  const runDir = path.join(outputRoot, name);

  fs.rmSync(runDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, runDir, { recursive: true });

  const matcher = new InstrumentationMatcher(configs);
  const transformer = matcher.getTransformer(
    TEST_MODULE_NAME,
    TEST_MODULE_VERSION,
    transformerFilePath,
  );

  expect(transformer).toBeDefined();

  const code = fs.readFileSync(path.join(runDir, `mod.${ext}`), "utf8");
  const transformed = transformer!.transform(code, mjs ? "esm" : "cjs");
  fs.writeFileSync(path.join(runDir, `instrumented.${ext}`), transformed.code);

  const result = spawnSync(process.execPath, [`test.${ext}`], {
    cwd: runDir,
    env: {
      ...process.env,
      BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME: globalHookRuntimePath,
    },
    stdio: "pipe",
  });
  const output =
    (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
  expect(result.status, output).toBe(0);
}

// Upstream cases for removed APIs are intentionally omitted: custom transforms,
// constructor-only configs, expression-name queries, and raw AST selectors.
const fixtureCases: UpstreamFixtureCase[] = [
  {
    name: "arguments_mutation",
    title: "supports argument mutation from invocation interceptors",
    configs: [
      config("fetch_simple", { functionName: "fetch_simple" }),
      config("fetch.complex", {
        functionName: "fetch_complex",
      }),
    ],
  },
  {
    name: "class_expression_cjs",
    title: "instruments async class methods on class expressions",
    configs: [
      config("Undici:fetch", {
        className: "Undici",
        methodName: "fetch",
      }),
    ],
  },
  {
    name: "class_method_cjs",
    title: "instruments async class methods",
    configs: [
      config("Undici:fetch", {
        className: "Undici",
        methodName: "fetch",
      }),
    ],
  },
  {
    name: "decl_cjs",
    title: "instruments async function declarations in CJS",
    configs: [config("fetch.decl", { functionName: "fetch" })],
  },
  {
    name: "decl_mjs",
    title: "instruments async function declarations in ESM",
    configs: [config("fetch_decl", { functionName: "fetch" })],
    mjs: true,
  },
  {
    name: "decl_mjs_mismatched_type",
    title: "preserves promises returned by synchronous function declarations",
    configs: [config("fetch_decl", { functionName: "fetch" })],
    mjs: true,
  },
  {
    name: "export_alias_mjs",
    title: "instruments function declarations via ESM export aliases",
    configs: [
      config("fetch_alias", {
        functionName: "fetchAliased",
        isExportAlias: true,
      }),
    ],
    mjs: true,
  },
  {
    name: "export_alias_class_mjs",
    title: "instruments class methods via ESM class export aliases",
    configs: [
      config("Undici:fetch", {
        className: "Undici",
        methodName: "fetch",
        isExportAlias: true,
      }),
    ],
    mjs: true,
  },
  {
    name: "const_class_export_alias_mjs",
    title: "instruments const class expressions via ESM export aliases",
    configs: [
      config("Undici:fetch", {
        className: "Undici",
        methodName: "fetch",
        isExportAlias: true,
      }),
    ],
    mjs: true,
  },
  {
    name: "let_class_export_alias_mjs",
    title: "instruments let class expressions via ESM export aliases",
    configs: [
      config("Undici:fetch", {
        className: "Undici",
        methodName: "fetch",
        isExportAlias: true,
      }),
    ],
    mjs: true,
  },
  {
    name: "var_class_export_alias_mjs",
    title: "instruments var class expressions via ESM export aliases",
    configs: [
      config("Undici:fetch", {
        className: "Undici",
        methodName: "fetch",
        isExportAlias: true,
      }),
    ],
    mjs: true,
  },
  {
    name: "var_named_class_export_alias_mjs",
    title: "instruments named var class expressions via ESM export aliases",
    configs: [
      config("Undici:fetch", {
        className: "Undici",
        methodName: "fetch",
        isExportAlias: true,
      }),
    ],
    mjs: true,
  },
  {
    name: "index_cjs",
    title: "instruments class methods by index",
    configs: [
      config("Undici_fetch", {
        className: "Undici",
        methodName: "fetch",
        index: 2,
      }),
    ],
  },
  {
    name: "instance_method_subclass_cjs",
    title: "instruments inherited methods via constructor patching",
    configs: [
      config("Base_fetch", {
        className: "Base",
        methodName: "fetch",
      }),
    ],
  },
  {
    name: "iife_nested_class",
    title: "instruments classes returned from IIFEs",
    configs: [
      config("register", {
        className: "Server",
        methodName: "register",
      }),
    ],
  },
  {
    name: "multiple_class_method_cjs",
    title: "instruments multiple class methods in one module",
    configs: [
      config("Undici_fetch1", {
        className: "Undici",
        methodName: "fetch1",
      }),
      config("Undici_fetch2", {
        className: "Undici",
        methodName: "fetch2",
      }),
    ],
  },
  {
    name: "multiple_load_cjs",
    title: "keeps transformed modules loadable across repeated matcher use",
    configs: [
      config("Undici_fetch", {
        className: "Undici",
        methodName: "fetch",
      }),
    ],
  },
  {
    name: "nested_functions",
    title: "instruments nested sync function declarations",
    configs: [config("nested_fn", { functionName: "addHook" })],
  },
  {
    name: "object_method_cjs",
    title: "instruments object methods with method-only configs",
    configs: [config("Undici_fetch", { methodName: "fetch" })],
  },
  {
    name: "object_property_this_cjs",
    title: "instruments async functions assigned to this properties",
    configs: [
      config("Connection_query", {
        propertyName: "_query",
      }),
    ],
  },

  {
    name: "promise_subclass",
    title: "preserves Promise subclass return values",
    configs: [config("fetch_subclass", { functionName: "fetch" })],
  },

  {
    name: "callback_cjs",
    title: "instruments callback-style functions",
    configs: [config("fetch.cb", { functionName: "fetch" })],
  },
  {
    name: "windows_path",
    title: "matches Windows-style transformed file paths",
    configs: [
      config("fetch_decl", { functionName: "fetch" }, WINDOWS_MODULE_PATH),
    ],
    transformerFilePath: "lib\\index.mjs",
  },
  {
    name: "wrap_promise_non_promise",
    title: "preserves non-Promise return values",
    configs: [config("fetch_nonpromise", { functionName: "fetch" })],
  },
];

describe("Orchestrion-JS upstream-derived behavior", () => {
  beforeAll(async () => {
    outputRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "braintrust-orchestrion-js-"),
    );
    globalHookRuntimePath = await buildTestGlobalHookRuntime(outputRoot);
    fs.cpSync(
      path.join(fixtureRoot, "common"),
      path.join(outputRoot, "common"),
      { recursive: true },
    );
  });

  afterAll(() => {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  for (const testCase of fixtureCases) {
    it(testCase.title, () => {
      runFixture(testCase);
    });
  }

  it("maps generated positions back to original line and column", async () => {
    const originalCode = [
      "async function fetch (url) {",
      "  return 42;",
      "}",
      "module.exports = { fetch };",
    ].join("\n");

    const matcher = new InstrumentationMatcher([
      config("fetch_sm", { functionName: "fetch" }),
    ]);
    const transformer = matcher.getTransformer(
      TEST_MODULE_NAME,
      TEST_MODULE_VERSION,
      TEST_MODULE_PATH,
    );

    expect(transformer).toBeDefined();
    const { code: generatedCode, map } = transformer!.transform(
      originalCode,
      "cjs",
    );

    expect(map).toBeDefined();

    await SourceMapConsumer.with(JSON.parse(map!), null, (consumer) => {
      const generatedLines = generatedCode.split("\n");
      const generatedLine =
        generatedLines.findIndex((line) => line.includes("return 42")) + 1;

      expect(generatedLine).toBeGreaterThan(0);

      const generatedColumn =
        generatedLines[generatedLine - 1]?.indexOf("42") ?? -1;
      const original = consumer.originalPositionFor({
        line: generatedLine,
        column: generatedColumn,
      });

      expect(original.line).toBe(2);
      expect(original.column).toBe(9);
    });
  });
});
