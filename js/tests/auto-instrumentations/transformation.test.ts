/**
 * ORCHESTRION TRANSFORMATION TESTS
 *
 * These tests verify that the internal Orchestrion-JS fork correctly
 * transforms code to inject tracingChannel calls at build time.
 *
 * IMPORTANT: Tests use a mock OpenAI package structure in test/fixtures/node_modules/openai.
 * IMPORTANT: dc-browser is now an npm package dependency.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as esbuild from "esbuild";
import { build as viteBuild } from "vite";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  create,
  type InstrumentationConfig,
} from "../../src/auto-instrumentations/orchestrion-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const outputDir = path.join(__dirname, "output-transformation");
const nodeModulesDir = path.join(fixturesDir, "node_modules");

function testConfig(
  functionQuery: InstrumentationConfig["functionQuery"],
  astQuery?: string,
): InstrumentationConfig {
  const config: InstrumentationConfig = {
    channelName: "test",
    module: {
      name: "test-sdk",
      versionRange: ">=1.0.0",
      filePath: "index.mjs",
    },
    functionQuery,
  };

  if (astQuery) {
    config.astQuery = astQuery;
  }

  return config;
}

function transformTestCode(
  functionQuery: InstrumentationConfig["functionQuery"],
  code: string,
  moduleType: "esm" | "cjs" = "esm",
  astQuery?: string,
) {
  const matcher = create([testConfig(functionQuery, astQuery)]);
  const transformer = matcher.getTransformer("test-sdk", "1.0.0", "index.mjs");

  expect(transformer).toBeDefined();
  return transformer!.transform(code, moduleType);
}

describe("Orchestrion Transformation Tests", () => {
  beforeAll(() => {
    // Create output directory
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Note: dc-browser is now an npm package, no symlinks needed
  });

  afterAll(() => {
    // Clean up test output
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  describe("internal transformer query surface", () => {
    it("supports class method configs", () => {
      const result = transformTestCode(
        { className: "Client", methodName: "create", kind: "Async" },
        `
          export class Client {
            async create(input) {
              return input;
            }
          }
        `,
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("tr_ch_apm$test.start.runStores");
    });

    it("supports method-only configs", () => {
      const result = transformTestCode(
        { methodName: "create", kind: "Async" },
        `
          export const client = {
            create: async function (input) {
              return input;
            },
          };
        `,
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("tr_ch_apm$test.start.runStores");
    });

    it("supports function declaration configs", () => {
      const result = transformTestCode(
        { functionName: "query", kind: "Sync" },
        `
          export function query(input) {
            return input;
          }
        `,
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("tr_ch_apm$test.start.runStores");
    });

    it("supports export-alias function configs", () => {
      const result = transformTestCode(
        { functionName: "query", kind: "Sync", isExportAlias: true },
        `
          function queryImpl(input) {
            return input;
          }
          export { queryImpl as query };
        `,
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("tr_ch_apm$test.start.runStores");
    });

    it("supports export-alias class method configs", () => {
      const result = transformTestCode(
        {
          className: "Client",
          methodName: "create",
          kind: "Async",
          isExportAlias: true,
        },
        `
          class Impl {
            async create(input) {
              return input;
            }
          }
          export { Impl as Client };
        `,
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("tr_ch_apm$test.start.runStores");
    });

    it("supports private class method configs", () => {
      const result = transformTestCode(
        { className: "Client", privateMethodName: "create", kind: "Async" },
        `
          class Client {
            async #create(input) {
              return input;
            }

            async run(input) {
              return this.#create(input);
            }
          }
          module.exports = Client;
        `,
        "cjs",
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("tr_ch_apm$test.start.runStores");
    });

    it("supports object/property configs", () => {
      const result = transformTestCode(
        { objectName: "this", propertyName: "create", kind: "Async" },
        `
          function Client() {
            this.create = async () => {
              return "ok";
            };
          }
          module.exports = Client;
        `,
        "cjs",
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("tr_ch_apm$test.start.runStores");
    });

    it("supports callback configs", () => {
      const result = transformTestCode(
        { functionName: "request", kind: "Callback" },
        `
          export function request(input, callback) {
            callback(null, input);
          }
        `,
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("Array.prototype.splice.call");
      expect(result.code).toContain("tr_ch_apm$test.asyncStart.runStores");
    });

    it("supports raw AST query configs", () => {
      const result = transformTestCode(
        { kind: "Async" },
        `
          export async function request(input) {
            return input;
          }
        `,
        "esm",
        'FunctionDeclaration[id.name="request"][async]',
      );

      expect(result.code).toContain("orchestrion:test-sdk:test");
      expect(result.code).toContain("tr_ch_apm$test.start.runStores");
    });

    it("supports index selection", () => {
      const result = transformTestCode(
        { methodName: "create", kind: "Async", index: 1 },
        `
          export const first = {
            create: async function firstCreate() {
              return "first";
            },
          };
          export const second = {
            create: async function secondCreate() {
              return "second";
            },
          };
        `,
      );

      const wrapperCount = result.code.match(
        /tr_ch_apm\$test\.start\.runStores/g,
      );
      expect(wrapperCount).toHaveLength(1);
      expect(result.code.indexOf("secondCreate")).toBeLessThan(
        result.code.indexOf("tr_ch_apm$test.start.runStores"),
      );
    });

    it("generates source maps", () => {
      const result = transformTestCode(
        { functionName: "query", kind: "Sync" },
        `
          export function query(input) {
            return input;
          }
        `,
      );

      expect(result.map).toBeDefined();
      expect(JSON.parse(result.map!)).toMatchObject({
        version: 3,
        file: "test-sdk/index.mjs",
      });
    });
  });

  describe("esbuild", () => {
    it("should transform OpenAI SDK code with tracingChannel", async () => {
      const { braintrustEsbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      const entryPoint = path.join(fixturesDir, "test-app.js");
      const outfile = path.join(outputDir, "esbuild-bundle.js");

      const result = await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [braintrustEsbuildPlugin()],
        logLevel: "error",
        absWorkingDir: fixturesDir,
        preserveSymlinks: true, // CRITICAL: Don't dereference symlinks!
        platform: "node", // Allow Node.js built-ins like diagnostics_channel
      });

      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(outfile)).toBe(true);

      const output = fs.readFileSync(outfile, "utf-8");

      // Verify orchestrion transformed the code
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");
      expect(output).not.toContain("TracingChannel");
    });

    it("should apply node top-level export patches", async () => {
      const { braintrustEsbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      const entryPoint = path.join(fixturesDir, "test-mastra-bundler.js");
      const outfile = path.join(outputDir, "esbuild-mastra-bundle.js");

      const result = await esbuild.build({
        absWorkingDir: fixturesDir,
        bundle: true,
        entryPoints: [entryPoint],
        format: "esm",
        logLevel: "error",
        outfile,
        platform: "node",
        plugins: [braintrustEsbuildPlugin()],
        preserveSymlinks: true,
        write: true,
      });

      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(outfile)).toBe(true);

      const output = fs.readFileSync(outfile, "utf-8");

      expect(output).toContain("__braintrustTopLevelImportHookRunner");
      expect(output).toContain("__braintrustExports");
      expect(output.replace(/\\/g, "/")).not.toContain(
        JSON.stringify(
          path
            .join(fixturesDir, "node_modules", "@mastra", "core")
            .replace(/\\/g, "/"),
        ),
      );
    });

    it("should bundle dc-browser module when useDiagnosticChannelCompatShim is true", async () => {
      const { braintrustEsbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      const entryPoint = path.join(fixturesDir, "test-app.js");
      const outfile = path.join(outputDir, "esbuild-browser-bundle.js");

      const result = await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [
          braintrustEsbuildPlugin({ useDiagnosticChannelCompatShim: true }),
        ],
        logLevel: "error",
        absWorkingDir: fixturesDir,
        preserveSymlinks: true,
        platform: "browser",
      });

      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(outfile)).toBe(true);

      const output = fs.readFileSync(outfile, "utf-8");

      // Verify orchestrion transformed the code
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");

      // Verify dc-browser module is bundled (should contain TracingChannel class implementation)
      expect(output).toContain("TracingChannel");
      // Should NOT import from external diagnostics_channel
      expect(output).not.toMatch(/from\s+["']diagnostics_channel["']/);
    });

    it("should skip node-only top-level export patches for browser bundles", async () => {
      const { braintrustEsbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      const entryPoint = path.join(fixturesDir, "test-mastra-bundler.js");
      const outfile = path.join(outputDir, "esbuild-mastra-browser-bundle.js");

      const result = await esbuild.build({
        absWorkingDir: fixturesDir,
        bundle: true,
        entryPoints: [entryPoint],
        format: "esm",
        logLevel: "error",
        outfile,
        platform: "browser",
        plugins: [
          braintrustEsbuildPlugin({ useDiagnosticChannelCompatShim: true }),
        ],
        preserveSymlinks: true,
        write: true,
      });

      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(outfile)).toBe(true);

      const output = fs.readFileSync(outfile, "utf-8");

      expect(output).not.toContain("__braintrustTopLevelImportHookRunner");
      expect(output).not.toContain("__braintrustOriginal");
    });

    it("should keep legacy default bundles browser-safe for top-level export patches", async () => {
      const { esbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      const entryPoint = path.join(fixturesDir, "test-mastra-bundler.js");
      const outfile = path.join(
        outputDir,
        "esbuild-mastra-legacy-default-bundle.js",
      );

      const result = await esbuild.build({
        absWorkingDir: fixturesDir,
        bundle: true,
        entryPoints: [entryPoint],
        format: "esm",
        logLevel: "error",
        outfile,
        platform: "browser",
        plugins: [esbuildPlugin()],
        preserveSymlinks: true,
        write: true,
      });

      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(outfile)).toBe(true);

      const output = fs.readFileSync(outfile, "utf-8");

      expect(output).not.toContain("__braintrustTopLevelImportHookRunner");
      expect(output).not.toContain("__braintrustOriginal");
    });
  });

  describe("vite", () => {
    it("should transform OpenAI SDK code with tracingChannel", async () => {
      const { braintrustVitePlugin } =
        await import("../../src/auto-instrumentations/bundler/vite.js");

      const entryPoint = path.join(fixturesDir, "test-app.js");
      const outDir = path.join(outputDir, "vite-dist");

      await viteBuild({
        root: fixturesDir,
        build: {
          lib: {
            entry: entryPoint,
            formats: ["es"],
            fileName: "bundle",
          },
          outDir,
          emptyOutDir: true,
          minify: false,
          rollupOptions: {
            external: ["diagnostics_channel"], // Mark Node built-ins as external, don't try to bundle them
          },
        },
        plugins: [braintrustVitePlugin()],
        logLevel: "error",
        resolve: {
          preserveSymlinks: true, // Don't dereference symlinks
        },
      });

      const bundlePath = path.join(outDir, "bundle.mjs");
      expect(fs.existsSync(bundlePath)).toBe(true);

      const output = fs.readFileSync(bundlePath, "utf-8");

      // Verify orchestrion transformed the code
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");
      expect(output).not.toContain("TracingChannel");
    });

    it("should bundle dc-browser module when useDiagnosticChannelCompatShim is true", async () => {
      const { braintrustVitePlugin } =
        await import("../../src/auto-instrumentations/bundler/vite.js");

      const entryPoint = path.join(fixturesDir, "test-app.js");
      const outDir = path.join(outputDir, "vite-browser-dist");

      await viteBuild({
        root: fixturesDir,
        build: {
          lib: {
            entry: entryPoint,
            formats: ["es"],
            fileName: "bundle",
          },
          outDir,
          emptyOutDir: true,
          minify: false,
        },
        plugins: [
          braintrustVitePlugin({ useDiagnosticChannelCompatShim: true }),
        ],
        logLevel: "error",
        resolve: {
          preserveSymlinks: true,
        },
      });

      const bundlePath = path.join(outDir, "bundle.mjs");
      expect(fs.existsSync(bundlePath)).toBe(true);

      const output = fs.readFileSync(bundlePath, "utf-8");

      // Verify orchestrion transformed the code
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");

      // Verify dc-browser module is bundled (should contain TracingChannel class implementation)
      expect(output).toContain("TracingChannel");
      // Should NOT import from external diagnostics_channel
      expect(output).not.toMatch(/from\s+["']diagnostics_channel["']/);
    });
  });

  describe("webpack", () => {
    async function runWebpack(
      config: object,
    ): Promise<{ errors: string[]; output: string; outputPath: string }> {
      const webpack = (await import("webpack")).default;
      return new Promise((resolve, reject) => {
        webpack(config as any, (err, stats) => {
          if (err) return reject(err);
          if (!stats) return reject(new Error("No stats returned"));

          const info = stats.toJson({ source: true });
          const errors = (info.errors ?? []).map((e: any) =>
            typeof e === "string" ? e : e.message,
          );

          const outputPath = (config as any).output?.path ?? outputDir;
          const filename = (config as any).output?.filename ?? "bundle.js";
          const fullPath = path.join(outputPath, filename);
          const output = fs.existsSync(fullPath)
            ? fs.readFileSync(fullPath, "utf-8")
            : "";

          resolve({ errors, output, outputPath: fullPath });
        });
      });
    }

    it("should transform OpenAI SDK code with tracingChannel", async () => {
      const { braintrustWebpackPlugin } =
        await import("../../src/auto-instrumentations/bundler/webpack.js");

      const { errors, output } = await runWebpack({
        entry: path.join(fixturesDir, "test-app.js"),
        output: {
          path: outputDir,
          filename: "webpack-bundle.js",
          library: { type: "module" },
        },
        experiments: { outputModule: true },
        mode: "development",
        resolve: { modules: [nodeModulesDir, "node_modules"] },
        externals: { diagnostics_channel: "module diagnostics_channel" },
        plugins: [braintrustWebpackPlugin()],
      });

      expect(errors).toHaveLength(0);
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");
      expect(output).not.toContain("TracingChannel");
    });

    it("should bundle dc-browser module when useDiagnosticChannelCompatShim is true", async () => {
      const { braintrustWebpackPlugin } =
        await import("../../src/auto-instrumentations/bundler/webpack.js");

      const { errors, output } = await runWebpack({
        entry: path.join(fixturesDir, "test-app.js"),
        output: {
          path: outputDir,
          filename: "webpack-browser-bundle.js",
          library: { type: "module" },
        },
        experiments: { outputModule: true },
        mode: "development",
        resolve: { modules: [nodeModulesDir, "node_modules"] },
        plugins: [
          braintrustWebpackPlugin({ useDiagnosticChannelCompatShim: true }),
        ],
      });

      expect(errors).toHaveLength(0);
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");
      expect(output).toContain("TracingChannel");
      expect(output).not.toMatch(/require\(["']diagnostics_channel["']\)/);
    });
  });

  describe("turbopack / webpack loader", () => {
    const webpackLoaderPath = path.resolve(
      __dirname,
      "../../dist/auto-instrumentations/bundler/webpack-loader.cjs",
    );
    async function runWebpackWithLoader(
      config: object,
    ): Promise<{ errors: string[]; output: string }> {
      const webpack = (await import("webpack")).default;
      return new Promise((resolve, reject) => {
        webpack(config as any, (err, stats) => {
          if (err) return reject(err);
          if (!stats) return reject(new Error("No stats returned"));

          const info = stats.toJson({ source: true });
          const errors = (info.errors ?? []).map((e: any) =>
            typeof e === "string" ? e : e.message,
          );

          const outputPath = (config as any).output?.path ?? outputDir;
          const filename = (config as any).output?.filename ?? "bundle.js";
          const fullPath = path.join(outputPath, filename);
          const output = fs.existsSync(fullPath)
            ? fs.readFileSync(fullPath, "utf-8")
            : "";

          resolve({ errors, output });
        });
      });
    }

    it("should transform OpenAI SDK code with tracingChannel (turbopack loader-only mode)", async () => {
      const { errors, output } = await runWebpackWithLoader({
        entry: path.join(fixturesDir, "test-app.js"),
        output: {
          path: outputDir,
          filename: "turbopack-bundle.js",
          library: { type: "module" },
        },
        experiments: { outputModule: true },
        mode: "development",
        resolve: { modules: [nodeModulesDir, "node_modules"] },
        externals: { diagnostics_channel: "module diagnostics_channel" },
        // No plugins — only the loader, mirroring turbopack's constraint
        module: {
          rules: [
            {
              use: [
                {
                  loader: webpackLoaderPath,
                  options: { browser: false },
                },
              ],
            },
          ],
        },
      });

      expect(errors).toHaveLength(0);
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");
    });

    it("should apply top-level export patches (turbopack loader-only mode)", async () => {
      const { errors, output } = await runWebpackWithLoader({
        entry: path.join(fixturesDir, "test-mastra-bundler.js"),
        output: {
          path: outputDir,
          filename: "turbopack-mastra-bundle.js",
          library: { type: "module" },
        },
        experiments: { outputModule: true },
        mode: "development",
        resolve: { modules: [nodeModulesDir, "node_modules"] },
        externals: { "node:module": "module node:module" },
        module: {
          rules: [
            {
              use: [
                {
                  loader: webpackLoaderPath,
                  options: { browser: false },
                },
              ],
            },
          ],
        },
      });

      expect(errors).toHaveLength(0);
      expect(output).toContain("__braintrustTopLevelImportHookRunner");
      expect(output).toContain("__braintrustExports");
    });

    it("should bundle dc-browser polyfill when browser: true (turbopack loader-only mode)", async () => {
      const { errors, output } = await runWebpackWithLoader({
        entry: path.join(fixturesDir, "test-app.js"),
        output: {
          path: outputDir,
          filename: "turbopack-browser-bundle.js",
          library: { type: "module" },
        },
        experiments: { outputModule: true },
        mode: "development",
        resolve: { modules: [nodeModulesDir, "node_modules"] },
        // No plugins — only the loader, mirroring turbopack's constraint
        module: {
          rules: [
            {
              use: [
                {
                  loader: webpackLoaderPath,
                  options: { browser: true },
                },
              ],
            },
          ],
        },
      });

      expect(errors).toHaveLength(0);
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");
      expect(output).toContain("TracingChannel");
      expect(output).not.toMatch(/require\(["']diagnostics_channel["']\)/);
    });
  });

  describe("rollup", () => {
    it("should transform OpenAI SDK code with tracingChannel", async () => {
      const { rollup } = await import("rollup");
      const { braintrustRollupPlugin } =
        await import("../../src/auto-instrumentations/bundler/rollup.js");

      const entryPoint = path.join(fixturesDir, "test-app.js");
      const outfile = path.join(outputDir, "rollup-bundle.js");

      // Simple resolver plugin to find modules in node_modules
      const resolverPlugin = {
        name: "resolver",
        resolveId(source: string, importer: string | undefined) {
          if (source.startsWith("openai")) {
            // Bundler resolveId always returns posix-style paths
            return path
              .resolve(fixturesDir, "node_modules", source)
              .replace(/\\/g, "/");
          }
          return null;
        },
      };

      const bundle = await rollup({
        input: entryPoint,
        plugins: [resolverPlugin, braintrustRollupPlugin()],
        external: [],
        preserveSymlinks: true, // Don't dereference symlinks
      });

      await bundle.write({
        file: outfile,
        format: "es",
      });

      await bundle.close();

      expect(fs.existsSync(outfile)).toBe(true);

      const output = fs.readFileSync(outfile, "utf-8");

      // Verify orchestrion transformed the code
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");
      expect(output).not.toContain("TracingChannel");
    });

    it("should bundle dc-browser module when useDiagnosticChannelCompatShim is true", async () => {
      const { rollup } = await import("rollup");
      const { braintrustRollupPlugin } =
        await import("../../src/auto-instrumentations/bundler/rollup.js");

      const entryPoint = path.join(fixturesDir, "test-app.js");
      const outfile = path.join(outputDir, "rollup-browser-bundle.js");

      // Simple resolver plugin to find modules in node_modules
      const resolverPlugin = {
        name: "resolver",
        resolveId(source: string, importer: string | undefined) {
          if (source.startsWith("openai")) {
            // Bundler resolveId always returns posix-style paths
            return path
              .resolve(fixturesDir, "node_modules", source)
              .replace(/\\/g, "/");
          }
          if (source === "dc-browser") {
            // Bundler resolveId always returns posix-style paths
            return path
              .resolve(
                __dirname,
                "../../node_modules/dc-browser/dist/index.mjs",
              )
              .replace(/\\/g, "/");
          }
          return null;
        },
      };

      const bundle = await rollup({
        input: entryPoint,
        plugins: [
          resolverPlugin,
          braintrustRollupPlugin({ useDiagnosticChannelCompatShim: true }),
        ],
        external: [],
        preserveSymlinks: true,
      });

      await bundle.write({
        file: outfile,
        format: "es",
      });

      await bundle.close();

      expect(fs.existsSync(outfile)).toBe(true);

      const output = fs.readFileSync(outfile, "utf-8");

      // Verify orchestrion transformed the code
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");

      // Verify dc-browser module is bundled (should contain TracingChannel class implementation)
      expect(output).toContain("TracingChannel");
      // Should NOT import from external diagnostics_channel
      expect(output).not.toMatch(/from\s+["']diagnostics_channel["']/);
    });
  });
});
