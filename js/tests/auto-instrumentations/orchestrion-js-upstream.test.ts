/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SourceMapConsumer } from "source-map";
import {
  create,
  type InstrumentationConfig,
} from "../../src/auto-instrumentations/orchestrion-js";

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
  dcModule?: string;
}

let outputRoot: string;

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
  dcModule,
}: UpstreamFixtureCase): void {
  const ext = mjs ? "mjs" : "js";
  const sourceDir = path.join(fixtureRoot, name);
  const runDir = path.join(outputRoot, name);

  fs.rmSync(runDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, runDir, { recursive: true });

  const matcher = create(configs, dcModule);
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
    stdio: "pipe",
  });
  const output =
    (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
  expect(result.status, output).toBe(0);
}

// Upstream cases for removed APIs are intentionally omitted: custom transforms,
// constructor-only configs, and expression-name queries.
const fixtureCases: UpstreamFixtureCase[] = [
  {
    name: "ast_query_cjs",
    title: "instruments using a raw AST query selector",
    configs: [
      {
        ...config("fetch_ast_query", { kind: "Async" }),
        astQuery: 'FunctionDeclaration[id.name="fetch"][async]',
      },
    ],
  },
  {
    name: "arguments_mutation",
    title: "supports argument mutation from tracing-channel subscribers",
    configs: [
      config("fetch_simple", { functionName: "fetch_simple", kind: "Sync" }),
      config("fetch.complex", {
        functionName: "fetch_complex",
        kind: "Sync",
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
        kind: "Async",
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
        kind: "Async",
      }),
    ],
  },
  {
    name: "decl_cjs",
    title: "instruments async function declarations in CJS",
    configs: [config("fetch.decl", { functionName: "fetch", kind: "Async" })],
  },
  {
    name: "decl_mjs",
    title: "instruments async function declarations in ESM",
    configs: [config("fetch_decl", { functionName: "fetch", kind: "Async" })],
    mjs: true,
  },
  {
    name: "decl_mjs_mismatched_type",
    title: "instruments promise-returning function declarations as async spans",
    configs: [config("fetch_decl", { functionName: "fetch", kind: "Async" })],
    mjs: true,
  },
  {
    name: "export_alias_mjs",
    title: "instruments function declarations via ESM export aliases",
    configs: [
      config("fetch_alias", {
        functionName: "fetchAliased",
        kind: "Async",
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
        kind: "Async",
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
        kind: "Async",
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
        kind: "Async",
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
        kind: "Async",
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
        kind: "Async",
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
        kind: "Async",
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
        kind: "Async",
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
        kind: "Sync",
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
        kind: "Async",
      }),
      config("Undici_fetch2", {
        className: "Undici",
        methodName: "fetch2",
        kind: "Async",
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
        kind: "Async",
      }),
    ],
  },
  {
    name: "nested_functions",
    title: "instruments nested sync function declarations",
    configs: [config("nested_fn", { functionName: "addHook", kind: "Sync" })],
  },
  {
    name: "object_method_cjs",
    title: "instruments object methods with method-only configs",
    configs: [config("Undici_fetch", { methodName: "fetch", kind: "Async" })],
  },
  {
    name: "object_property_this_cjs",
    title: "instruments async functions assigned to this properties",
    configs: [
      config("Connection_query", {
        objectName: "this",
        propertyName: "_query",
        kind: "Async",
      }),
    ],
  },
  {
    name: "object_property_named_cjs",
    title: "instruments async functions assigned to named object properties",
    configs: [
      config("conn_query", {
        objectName: "conn",
        propertyName: "query",
        kind: "Async",
      }),
    ],
  },
  {
    name: "polyfill_cjs",
    title: "supports a custom diagnostics channel module in CJS",
    configs: [config("fetch_decl", { functionName: "fetch", kind: "Async" })],
    dcModule: "./polyfill.js",
  },
  {
    name: "polyfill_mjs",
    title: "supports a custom diagnostics channel module in ESM",
    configs: [config("fetch_decl", { functionName: "fetch", kind: "Async" })],
    dcModule: "./polyfill.js",
    mjs: true,
  },
  {
    name: "promise_subclass",
    title: "preserves Promise subclass return values",
    configs: [
      config("fetch_subclass", { functionName: "fetch", kind: "Async" }),
    ],
  },
  {
    name: "private_method_cjs",
    title: "instruments async private class methods",
    configs: [
      config("TestClass:testMe", {
        className: "TestClass",
        privateMethodName: "testMe",
        kind: "Async",
      }),
    ],
  },
  {
    name: "callback_cjs",
    title: "instruments callback-style functions",
    configs: [config("fetch.cb", { functionName: "fetch", kind: "Callback" })],
  },
  {
    name: "windows_path",
    title: "matches Windows-style transformed file paths",
    configs: [
      config(
        "fetch_decl",
        { functionName: "fetch", kind: "Async" },
        WINDOWS_MODULE_PATH,
      ),
    ],
    transformerFilePath: "lib\\index.mjs",
  },
  {
    name: "wrap_promise_non_promise",
    title: "handles non-Promise returns from Async configs",
    configs: [
      config("fetch_nonpromise", { functionName: "fetch", kind: "Async" }),
    ],
  },
];

describe("Orchestrion-JS upstream-derived behavior", () => {
  beforeAll(() => {
    outputRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "braintrust-orchestrion-js-"),
    );
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

  it("accepts Buffer input and produces the same output as string input", () => {
    const code = [
      "async function fetch (url) {",
      "  return 42;",
      "}",
      "module.exports = { fetch };",
    ].join("\n");

    const matcher = create([
      config("fetch", { functionName: "fetch", kind: "Async" }),
    ]);
    const transformer = matcher.getTransformer(
      TEST_MODULE_NAME,
      TEST_MODULE_VERSION,
      TEST_MODULE_PATH,
    );

    expect(transformer).toBeDefined();
    const fromString = transformer!.transform(code, "cjs");
    const fromBuffer = transformer!.transform(Buffer.from(code), "cjs");

    expect(fromBuffer.code).toEqual(fromString.code);
  });

  it("maps generated positions back to original line and column", async () => {
    const originalCode = [
      "async function fetch (url) {",
      "  return 42;",
      "}",
      "module.exports = { fetch };",
    ].join("\n");

    const matcher = create([
      config("fetch_sm", { functionName: "fetch", kind: "Async" }),
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
