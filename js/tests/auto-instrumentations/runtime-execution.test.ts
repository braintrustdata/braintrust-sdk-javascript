/**
 * RUNTIME EXECUTION TESTS
 *
 * These tests verify that bundled code actually runs correctly:
 * - esbuild output can execute
 * - Vite output can execute
 * - Rollup output can execute
 * - No runtime errors from transformation
 * - Code behaves identically to non-instrumented version
 *
 * This is crucial to ensure transformations don't break working code.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as esbuild from "esbuild";
import { build as viteBuild } from "vite";
import { rollup } from "rollup";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const testFilesDir = path.join(fixturesDir, "test-files");
const outputDir = path.join(__dirname, "output-runtime-execution");

describe("Runtime Execution of Bundled Code", () => {
  beforeAll(() => {
    // Create test-files and output directories
    if (!fs.existsSync(testFilesDir)) {
      fs.mkdirSync(testFilesDir, { recursive: true });
    }
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
    // Note: Don't clean up test-files directory to avoid race conditions with parallel tests
  });

  describe("esbuild bundle execution", () => {
    it("should execute simple async function call", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ result: 'success', value: 42 })
        });

        export async function run() {
          const result = await completions.create({ model: 'gpt-4', messages: [] });
          return result;
        }
      `;

      const entryPoint = path.join(testFilesDir, "esbuild-exec-test.mjs");
      const outfile = path.join(outputDir, "esbuild-exec-bundle.mjs");

      fs.writeFileSync(entryPoint, testCode);

      const { esbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [esbuildPlugin({ browser: false })],
        logLevel: "error",
        absWorkingDir: fixturesDir,
        preserveSymlinks: true,
        platform: "node",
      });

      // Execute the bundle
      const bundled = await import(outfile);
      const result = await bundled.run();

      // Verify execution succeeded and returned correct value
      expect(result).toEqual({ result: "success", value: 42 });
    });

    it("should execute code with control flow (if/else, loops)", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async (path, params) => {
            return { model: params.model };
          }
        });

        export async function run() {
          const results = [];
          const models = ['gpt-4', 'gpt-3.5-turbo', 'gpt-4-turbo'];

          for (const model of models) {
            const result = await completions.create({ model, messages: [] });
            if (result.model.includes('turbo')) {
              results.push({ model: result.model, type: 'turbo' });
            } else {
              results.push({ model: result.model, type: 'standard' });
            }
          }

          return results;
        }
      `;

      const entryPoint = path.join(
        testFilesDir,
        "esbuild-controlflow-test.mjs",
      );
      const outfile = path.join(outputDir, "esbuild-controlflow-bundle.mjs");

      fs.writeFileSync(entryPoint, testCode);

      const { esbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [esbuildPlugin({ browser: false })],
        logLevel: "error",
        absWorkingDir: fixturesDir,
        preserveSymlinks: true,
        platform: "node",
      });

      const bundled = await import(outfile);
      const results = await bundled.run();

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ model: "gpt-4", type: "standard" });
      expect(results[1]).toEqual({ model: "gpt-3.5-turbo", type: "turbo" });
      expect(results[2]).toEqual({ model: "gpt-4-turbo", type: "turbo" });
    });

    it("should execute code with try/catch error handling", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        let callCount = 0;
        const completions = new Completions({
          post: async () => {
            callCount++;
            if (callCount === 1) {
              throw new Error('First call fails');
            }
            return { success: true };
          }
        });

        export async function run() {
          let firstCallFailed = false;
          let secondCallSucceeded = false;

          try {
            await completions.create({ model: 'gpt-4', messages: [] });
          } catch (e) {
            firstCallFailed = e.message === 'First call fails';
          }

          try {
            const result = await completions.create({ model: 'gpt-4', messages: [] });
            secondCallSucceeded = result.success === true;
          } catch (e) {
            secondCallSucceeded = false;
          }

          return { firstCallFailed, secondCallSucceeded };
        }
      `;

      const entryPoint = path.join(testFilesDir, "esbuild-trycatch-test.mjs");
      const outfile = path.join(outputDir, "esbuild-trycatch-bundle.mjs");

      fs.writeFileSync(entryPoint, testCode);

      const { esbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [esbuildPlugin({ browser: false })],
        logLevel: "error",
        absWorkingDir: fixturesDir,
        preserveSymlinks: true,
        platform: "node",
      });

      const bundled = await import(outfile);
      const result = await bundled.run();

      expect(result).toEqual({
        firstCallFailed: true,
        secondCallSucceeded: true,
      });
    });
  });

  describe("vite bundle execution", () => {
    it("should execute simple async function call", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ framework: 'vite', works: true })
        });

        export async function run() {
          return await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "vite-exec-test.mjs");
      const outDir = path.join(outputDir, "vite-exec-dist");

      fs.writeFileSync(entryPoint, testCode);

      const { vitePlugin } =
        await import("../../src/auto-instrumentations/bundler/vite.js");

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
            external: ["diagnostics_channel"],
          },
        },
        plugins: [vitePlugin({ browser: false })],
        logLevel: "error",
        resolve: {
          preserveSymlinks: true,
        },
      });

      const bundlePath = path.join(outDir, "bundle.mjs");
      const bundled = await import(bundlePath);
      const result = await bundled.run();

      expect(result).toEqual({ framework: "vite", works: true });
    });

    it("should execute code with complex async operations", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async (path, params) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            return { count: params.messages.length };
          }
        });

        export async function run() {
          const tasks = [];
          for (let i = 1; i <= 3; i++) {
            tasks.push(
              completions.create({
                model: 'gpt-4',
                messages: Array(i).fill({ role: 'user', content: 'test' })
              })
            );
          }
          return await Promise.all(tasks);
        }
      `;

      const entryPoint = path.join(testFilesDir, "vite-async-test.mjs");
      const outDir = path.join(outputDir, "vite-async-dist");

      fs.writeFileSync(entryPoint, testCode);

      const { vitePlugin } =
        await import("../../src/auto-instrumentations/bundler/vite.js");

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
            external: ["diagnostics_channel"],
          },
        },
        plugins: [vitePlugin({ browser: false })],
        logLevel: "error",
        resolve: {
          preserveSymlinks: true,
        },
      });

      const bundlePath = path.join(outDir, "bundle.mjs");
      const bundled = await import(bundlePath);
      const results = await bundled.run();

      expect(results).toHaveLength(3);
      expect(results[0].count).toBe(1);
      expect(results[1].count).toBe(2);
      expect(results[2].count).toBe(3);
    });
  });

  describe("rollup bundle execution", () => {
    it("should execute simple async function call", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ bundler: 'rollup', status: 'operational' })
        });

        export async function run() {
          return await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "rollup-exec-test.mjs");
      const outfile = path.join(outputDir, "rollup-exec-bundle.mjs");

      fs.writeFileSync(entryPoint, testCode);

      const { rollupPlugin } =
        await import("../../src/auto-instrumentations/bundler/rollup.js");

      // Simple resolver plugin
      const resolverPlugin = {
        name: "resolver",
        resolveId(source: string) {
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
        plugins: [resolverPlugin, rollupPlugin({ browser: false })],
        external: [],
        preserveSymlinks: true,
      });

      await bundle.write({
        file: outfile,
        format: "es",
      });

      await bundle.close();

      const bundled = await import(outfile);
      const result = await bundled.run();

      expect(result).toEqual({ bundler: "rollup", status: "operational" });
    });

    it("should execute code with nested function calls", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async (path, params) => ({ model: params.model })
        });

        async function level3(model) {
          return await completions.create({ model, messages: [] });
        }

        async function level2(model) {
          const result = await level3(model);
          return { ...result, level: 2 };
        }

        async function level1(model) {
          const result = await level2(model);
          return { ...result, level: 1 };
        }

        export async function run() {
          return await level1('gpt-4');
        }
      `;

      const entryPoint = path.join(testFilesDir, "rollup-nested-test.mjs");
      const outfile = path.join(outputDir, "rollup-nested-bundle.mjs");

      fs.writeFileSync(entryPoint, testCode);

      const { rollupPlugin } =
        await import("../../src/auto-instrumentations/bundler/rollup.js");

      const resolverPlugin = {
        name: "resolver",
        resolveId(source: string) {
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
        plugins: [resolverPlugin, rollupPlugin({ browser: false })],
        external: [],
        preserveSymlinks: true,
      });

      await bundle.write({
        file: outfile,
        format: "es",
      });

      await bundle.close();

      const bundled = await import(outfile);
      const result = await bundled.run();

      expect(result).toEqual({ model: "gpt-4", level: 1 });
    });
  });

  describe("No runtime errors", () => {
    it("should not introduce undefined variable errors", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ defined: true })
        });

        export async function run() {
          // Access various properties to ensure nothing is undefined
          const result = await completions.create({ model: 'gpt-4', messages: [] });
          return {
            hasCompletions: typeof completions !== 'undefined',
            hasCreate: typeof completions.create === 'function',
            hasResult: typeof result !== 'undefined',
            resultDefined: result.defined
          };
        }
      `;

      const entryPoint = path.join(testFilesDir, "no-undefined-test.mjs");
      const outfile = path.join(outputDir, "no-undefined-bundle.mjs");

      fs.writeFileSync(entryPoint, testCode);

      const { esbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [esbuildPlugin({ browser: false })],
        logLevel: "error",
        absWorkingDir: fixturesDir,
        preserveSymlinks: true,
        platform: "node",
      });

      const bundled = await import(outfile);
      const result = await bundled.run();

      expect(result).toEqual({
        hasCompletions: true,
        hasCreate: true,
        hasResult: true,
        resultDefined: true,
      });
    });

    it("should not break variable scoping", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const globalVar = 'global';

        export async function run() {
          const localVar = 'local';
          let results = [];

          const completions = new Completions({
            post: async () => {
              const innerVar = 'inner';
              return { globalVar, localVar, innerVar };
            }
          });

          const result = await completions.create({ model: 'gpt-4', messages: [] });
          return result;
        }
      `;

      const entryPoint = path.join(testFilesDir, "scoping-test.mjs");
      const outfile = path.join(outputDir, "scoping-bundle.mjs");

      fs.writeFileSync(entryPoint, testCode);

      const { esbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [esbuildPlugin({ browser: false })],
        logLevel: "error",
        absWorkingDir: fixturesDir,
        preserveSymlinks: true,
        platform: "node",
      });

      const bundled = await import(outfile);
      const result = await bundled.run();

      expect(result).toEqual({
        globalVar: "global",
        localVar: "local",
        innerVar: "inner",
      });
    });
  });
});
