/**
 * ORCHESTRION TRANSFORMATION TESTS
 *
 * These tests verify that @apm-js-collab/code-transformer (orchestrion)
 * correctly transforms code to inject tracingChannel calls at build time.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const outputDir = path.join(__dirname, "output-transformation");
const nodeModulesDir = path.join(fixturesDir, "node_modules");

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

  describe("esbuild", () => {
    it("should transform OpenAI SDK code with tracingChannel", async () => {
      const { esbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      const entryPoint = path.join(fixturesDir, "test-app.js");
      const outfile = path.join(outputDir, "esbuild-bundle.js");

      const result = await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [
          esbuildPlugin({ browser: false }), // Use Node.js built-in for tests
        ],
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
      expect(output).toContain("tracePromise");
    });

    it("should bundle dc-browser module when browser: true", async () => {
      const { esbuildPlugin } =
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
          esbuildPlugin({ browser: true }), // Use browser mode
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
  });

  describe("vite", () => {
    it("should transform OpenAI SDK code with tracingChannel", async () => {
      const { vitePlugin } =
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
        plugins: [
          vitePlugin({ browser: false }), // Use Node.js built-in for tests
        ],
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
      expect(output).toContain("tracePromise");
    });

    it("should bundle dc-browser module when browser: true", async () => {
      const { vitePlugin } =
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
          vitePlugin({ browser: true }), // Use browser mode
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
      const { webpackPlugin } =
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
        plugins: [webpackPlugin({ browser: false })],
      });

      expect(errors).toHaveLength(0);
      expect(output).toContain("tracingChannel");
      expect(output).toContain("orchestrion:openai:chat.completions.create");
      expect(output).toContain("tracePromise");
    });

    it("should bundle dc-browser module when browser: true", async () => {
      const { webpackPlugin } =
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
        plugins: [webpackPlugin({ browser: true })],
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
      expect(output).toContain("tracePromise");
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
      const { rollupPlugin } =
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
        plugins: [
          resolverPlugin,
          rollupPlugin({ browser: false }), // Use Node.js built-in for tests
        ],
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
      expect(output).toContain("tracePromise");
    });

    it("should bundle dc-browser module when browser: true", async () => {
      const { rollup } = await import("rollup");
      const { rollupPlugin } =
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
          rollupPlugin({ browser: true }), // Use browser mode
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
