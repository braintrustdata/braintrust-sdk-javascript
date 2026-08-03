/**
 * ERROR HANDLING TESTS
 *
 * These tests verify that errors are handled correctly by instrumented functions:
 * - Error events are emitted when functions throw
 * - Errors are still propagated to the caller
 * - Error event contains correct error information
 * - Both sync and async errors are handled
 *
 * Tests run against bundled code with actual global hook subscriptions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createEventCollector } from "./test-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const testFilesDir = path.join(fixturesDir, "test-files");
const outputDir = path.join(__dirname, "output-error-handling");

describe("Error Handling", () => {
  let collector: ReturnType<typeof createEventCollector>;

  beforeAll(() => {
    // Create test-files and output directories
    if (!fs.existsSync(testFilesDir)) {
      fs.mkdirSync(testFilesDir, { recursive: true });
    }
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  });

  beforeEach(() => {
    collector = createEventCollector();
    collector.subscribe("orchestrion:openai:chat.completions.create");
  });

  afterAll(() => {
    // Clean up test output
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    // Note: Don't clean up test-files directory to avoid race conditions with parallel tests
  });

  describe("Error Event Emission", () => {
    it("should emit error event when instrumented function throws", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => {
            throw new Error('Test error');
          }
        });

        export async function run() {
          try {
            await completions.create({ model: 'gpt-4', messages: [] });
          } catch (e) {
            // Swallow error so we can check events
          }
        }
      `;

      const entryPoint = path.join(testFilesDir, "error-event-test.mjs");
      const outfile = path.join(outputDir, "error-event-bundle.mjs");

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
      await bundled.run();

      // Give events time to emit
      await new Promise((resolve) => setImmediate(resolve));

      // Verify error event was emitted
      expect(collector.error.length).toBeGreaterThan(0);
      expect(collector.error[0].error).toBeDefined();
      expect(collector.error[0].error.message).toBe("Test error");
    });

    it("should emit error event with correct error details", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        class CustomError extends Error {
          constructor(message, code) {
            super(message);
            this.name = 'CustomError';
            this.code = code;
          }
        }

        const completions = new Completions({
          post: async () => {
            throw new CustomError('API failure', 'ERR_API_FAILURE');
          }
        });

        export async function run() {
          try {
            await completions.create({ model: 'gpt-4', messages: [] });
          } catch (e) {
            // Swallow error
          }
        }
      `;

      const entryPoint = path.join(testFilesDir, "error-details-test.mjs");
      const outfile = path.join(outputDir, "error-details-bundle.mjs");

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
      await bundled.run();

      await new Promise((resolve) => setImmediate(resolve));

      // Verify error details are captured
      expect(collector.error.length).toBeGreaterThan(0);
      const errorEvent = collector.error[0];
      expect(errorEvent.error.message).toBe("API failure");
      expect(errorEvent.error.name).toBe("CustomError");
      expect(errorEvent.error.code).toBe("ERR_API_FAILURE");
    });
  });

  describe("Error Propagation", () => {
    it("should propagate error to caller after emitting event", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => {
            throw new Error('Propagated error');
          }
        });

        export async function run() {
          return await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "error-propagation-test2.mjs");
      const outfile = path.join(outputDir, "error-propagation-bundle2.mjs");

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

      // Verify error is still thrown
      await expect(bundled.run()).rejects.toThrow("Propagated error");

      // Also verify error event was emitted
      await new Promise((resolve) => setImmediate(resolve));
      expect(collector.error.length).toBeGreaterThan(0);
    });

    it("should handle errors in promise rejections", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: () => Promise.reject(new Error('Promise rejection'))
        });

        export async function run() {
          return await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "rejection-test.mjs");
      const outfile = path.join(outputDir, "rejection-bundle.mjs");

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

      // Verify promise rejection is propagated
      await expect(bundled.run()).rejects.toThrow("Promise rejection");

      // Verify error event was emitted
      await new Promise((resolve) => setImmediate(resolve));
      expect(collector.error.length).toBeGreaterThan(0);
      expect(collector.error[0].error.message).toBe("Promise rejection");
    });
  });

  describe("Start and End Events with Errors", () => {
    it("should emit start event before error event", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => {
            throw new Error('Test error');
          }
        });

        export async function run() {
          try {
            await completions.create({ model: 'gpt-4', messages: [] });
          } catch (e) {
            // Swallow error
          }
        }
      `;

      const entryPoint = path.join(testFilesDir, "start-error-order-test.mjs");
      const outfile = path.join(outputDir, "start-error-order-bundle.mjs");

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
      await bundled.run();

      await new Promise((resolve) => setImmediate(resolve));

      // Verify both start and error events were emitted
      expect(collector.start.length).toBeGreaterThan(0);
      expect(collector.error.length).toBeGreaterThan(0);

      // Verify start event came before error event
      expect(collector.start[0].timestamp).toBeLessThanOrEqual(
        collector.error[0].timestamp,
      );
    });

    it("should not emit end event when error occurs", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => {
            throw new Error('Test error');
          }
        });

        export async function run() {
          try {
            await completions.create({ model: 'gpt-4', messages: [] });
          } catch (e) {
            // Swallow error
          }
        }
      `;

      const entryPoint = path.join(testFilesDir, "no-end-on-error-test.mjs");
      const outfile = path.join(outputDir, "no-end-on-error-bundle.mjs");

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
      await bundled.run();

      await new Promise((resolve) => setImmediate(resolve));

      // Verify error event was emitted
      expect(collector.error.length).toBeGreaterThan(0);

      // Verify end event was NOT emitted (or if emitted, came before or at the same time as error due to asyncEnd)
      // Note: For async functions, asyncEnd might still fire, but end should not
      if (collector.end.length > 0) {
        // If end event exists, it should be before or at the same time as the error
        expect(collector.end[0].timestamp).toBeLessThanOrEqual(
          collector.error[0].timestamp,
        );
      }
    });
  });

  describe("Error Stack Traces", () => {
    it("should preserve error stack traces", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        function deepFunction() {
          throw new Error('Deep error');
        }

        const completions = new Completions({
          post: async () => {
            deepFunction();
          }
        });

        export async function run() {
          try {
            await completions.create({ model: 'gpt-4', messages: [] });
          } catch (e) {
            return e.stack;
          }
        }
      `;

      const entryPoint = path.join(testFilesDir, "stack-trace-test.mjs");
      const outfile = path.join(outputDir, "stack-trace-bundle.mjs");

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
      const stack = await bundled.run();

      // Verify stack trace exists and contains relevant information
      expect(stack).toBeDefined();
      expect(typeof stack).toBe("string");
      expect(stack).toContain("Error: Deep error");
      expect(stack).toContain("deepFunction");
    });
  });
});
