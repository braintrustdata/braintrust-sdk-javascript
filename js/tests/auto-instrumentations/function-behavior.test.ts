/**
 * FUNCTION BEHAVIOR PRESERVATION TESTS
 *
 * These tests verify that instrumented functions preserve their original behavior:
 * - Return values (sync and async)
 * - Error propagation
 * - `this` binding
 * - Arguments
 * - Async behavior (promises)
 *
 * Tests run against bundled code to ensure the transformation works in practice.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const testFilesDir = path.join(fixturesDir, "test-files");
const outputDir = path.join(__dirname, "output-function-behavior");

describe("Function Behavior Preservation", () => {
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

  describe("Return Value Preservation", () => {
    it("should preserve return values from async functions", async () => {
      // Create test fixture
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const expectedResult = { choices: [{ message: { content: 'Hello' } }], model: 'gpt-4' };
        const completions = new Completions({
          post: async () => expectedResult
        });

        export async function run() {
          const result = await completions.create({ model: 'gpt-4', messages: [] });
          return result;
        }
      `;

      const entryPoint = path.join(testFilesDir, "return-value-test.mjs");
      const outfile = path.join(outputDir, "return-value-bundle.mjs");

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

      // Import and run the bundled code
      const bundled = await import(outfile);
      const result = await bundled.run();

      // Verify the return value is preserved
      expect(result).toBeDefined();
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.content).toBe("Hello");
      expect(result.model).toBe("gpt-4");
    });

    it("should preserve complex nested return values", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const complexResult = {
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: 1677652288,
          model: 'gpt-4',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Hello! How can I help?',
                function_call: null
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 12,
            total_tokens: 21
          }
        };

        const completions = new Completions({
          post: async () => complexResult
        });

        export async function run() {
          return await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "complex-return-test.mjs");
      const outfile = path.join(outputDir, "complex-return-bundle.mjs");

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

      // Verify complex structure is preserved
      expect(result.id).toBe("chatcmpl-123");
      expect(result.usage.total_tokens).toBe(21);
      expect(result.choices[0].message.content).toBe("Hello! How can I help?");
    });
  });

  describe("Error Propagation", () => {
    it("should propagate errors thrown by instrumented functions", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => {
            throw new Error('API Error: Rate limit exceeded');
          }
        });

        export async function run() {
          return await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "error-propagation-test.mjs");
      const outfile = path.join(outputDir, "error-propagation-bundle.mjs");

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

      // Verify error is propagated
      await expect(bundled.run()).rejects.toThrow(
        "API Error: Rate limit exceeded",
      );
    });

    it("should preserve error types and properties", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        class CustomAPIError extends Error {
          constructor(message, statusCode) {
            super(message);
            this.name = 'CustomAPIError';
            this.statusCode = statusCode;
          }
        }

        const completions = new Completions({
          post: async () => {
            throw new CustomAPIError('Invalid API key', 401);
          }
        });

        export async function run() {
          return await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "error-type-test.mjs");
      const outfile = path.join(outputDir, "error-type-bundle.mjs");

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

      try {
        await bundled.run();
        expect.fail("Should have thrown an error");
      } catch (error: any) {
        expect(error.message).toBe("Invalid API key");
        expect(error.name).toBe("CustomAPIError");
        expect(error.statusCode).toBe(401);
      }
    });
  });

  describe("This Binding Preservation", () => {
    it("should preserve 'this' context when calling instrumented methods", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const testClient = {
          apiKey: 'test-key-123',
          post: async function(path, params) {
            return { model: 'gpt-4', apiKey: this.apiKey };
          }
        };

        const completions = new Completions(testClient);

        export async function run() {
          const result = await completions.create({ model: 'gpt-4', messages: [] });
          return result;
        }
      `;

      const entryPoint = path.join(testFilesDir, "this-binding-test.mjs");
      const outfile = path.join(outputDir, "this-binding-bundle.mjs");

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

      // Verify 'this' context was preserved
      expect(result.apiKey).toBe("test-key-123");
    });
  });

  describe("Arguments Preservation", () => {
    it("should preserve all arguments passed to instrumented functions", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        let capturedArgs = null;
        const completions = new Completions({
          post: async (path, params) => {
            capturedArgs = { path, params };
            return { model: params.model, messages: params.messages };
          }
        });

        export async function run() {
          const params = {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hello' }],
            temperature: 0.7,
            max_tokens: 100
          };
          await completions.create(params);
          return capturedArgs;
        }
      `;

      const entryPoint = path.join(testFilesDir, "arguments-test.mjs");
      const outfile = path.join(outputDir, "arguments-bundle.mjs");

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
      const capturedArgs = await bundled.run();

      // Verify all arguments were passed correctly
      expect(capturedArgs).toBeDefined();
      expect(capturedArgs.params.model).toBe("gpt-4");
      expect(capturedArgs.params.temperature).toBe(0.7);
      expect(capturedArgs.params.max_tokens).toBe(100);
      expect(capturedArgs.params.messages).toHaveLength(1);
    });
  });

  describe("Async Behavior Preservation", () => {
    it("should maintain proper promise behavior", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async (path, params) => {
            // Simulate network delay
            await new Promise(resolve => setTimeout(resolve, 10));
            return { model: params.model, delayed: true };
          }
        });

        export async function run() {
          const start = Date.now();
          const result = await completions.create({ model: 'gpt-4', messages: [] });
          const elapsed = Date.now() - start;
          return { result, elapsed };
        }
      `;

      const entryPoint = path.join(testFilesDir, "async-behavior-test.mjs");
      const outfile = path.join(outputDir, "async-behavior-bundle.mjs");

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
      const { result, elapsed } = await bundled.run();

      // Verify async behavior was preserved
      expect(result.delayed).toBe(true);
      // Allow for timer precision variations (9-11ms for a 10ms setTimeout)
      expect(elapsed).toBeGreaterThanOrEqual(9);
    });

    it("should handle promise chains correctly", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ value: 1 })
        });

        export async function run() {
          return completions.create({ model: 'gpt-4', messages: [] })
            .then(result => ({ ...result, value: result.value + 1 }))
            .then(result => ({ ...result, value: result.value * 2 }))
            .catch(error => ({ error: error.message }));
        }
      `;

      const entryPoint = path.join(testFilesDir, "promise-chain-test.mjs");
      const outfile = path.join(outputDir, "promise-chain-bundle.mjs");

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

      // Verify promise chain was executed correctly: (1 + 1) * 2 = 4
      expect(result.value).toBe(4);
    });

    it("should handle concurrent async calls correctly", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        let callCount = 0;
        const completions = new Completions({
          post: async (path, params) => {
            const id = ++callCount;
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            return { id, model: params.model };
          }
        });

        export async function run() {
          const promises = [
            completions.create({ model: 'gpt-4', messages: [] }),
            completions.create({ model: 'gpt-3.5-turbo', messages: [] }),
            completions.create({ model: 'gpt-4-turbo', messages: [] })
          ];
          return await Promise.all(promises);
        }
      `;

      const entryPoint = path.join(testFilesDir, "concurrent-test.mjs");
      const outfile = path.join(outputDir, "concurrent-bundle.mjs");

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

      // Verify all three calls completed
      expect(results).toHaveLength(3);
      expect(results[0].model).toBe("gpt-4");
      expect(results[1].model).toBe("gpt-3.5-turbo");
      expect(results[2].model).toBe("gpt-4-turbo");

      // Verify each got a unique ID
      const ids = results.map((r: any) => r.id);
      expect(new Set(ids).size).toBe(3);
    });
  });
});
