/**
 * MULTIPLE INSTRUMENTATIONS TESTS
 *
 * These tests verify that multiple instrumentation points work correctly:
 * - Multiple methods on the same class can be instrumented
 * - Each method emits to its own channel
 * - Methods don't interfere with each other
 * - Multiple configs for different classes work together
 *
 * Tests use mock modules that simulate having multiple instrumented methods.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createEventCollector } from "./test-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const testFilesDir = path.join(fixturesDir, "test-files");
const outputDir = path.join(__dirname, "output-multiple-instrumentations");
const nodeModulesDir = path.join(fixturesDir, "node_modules");

describe("Multiple Instrumentations", () => {
  beforeAll(() => {
    // Create test-files and output directories
    if (!fs.existsSync(testFilesDir)) {
      fs.mkdirSync(testFilesDir, { recursive: true });
    }
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Create mock embeddings module for testing multiple methods
    const embeddingsDir = path.join(nodeModulesDir, "openai/resources");
    if (!fs.existsSync(embeddingsDir)) {
      fs.mkdirSync(embeddingsDir, { recursive: true });
    }

    const embeddingsFile = path.join(embeddingsDir, "embeddings.mjs");
    if (!fs.existsSync(embeddingsFile)) {
      fs.writeFileSync(
        embeddingsFile,
        `export class Embeddings {
  constructor(client) {
    this._client = client;
  }

  async create(params) {
    return this._client.post('/embeddings', params);
  }
}`,
      );
    }
  });

  afterAll(() => {
    // Clean up test output
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    // Note: Don't clean up test-files directory to avoid race conditions with parallel tests
  });

  describe("Multiple methods on different classes", () => {
    it("should instrument both chat completions and embeddings independently", async () => {
      const chatCollector = createEventCollector();
      chatCollector.subscribe("orchestrion:openai:chat.completions.create");

      const embeddingsCollector = createEventCollector();
      embeddingsCollector.subscribe("orchestrion:openai:embeddings.create");

      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';
        import { Embeddings } from 'openai/resources/embeddings.mjs';

        const client = {
          post: async (path, params) => {
            if (path === '/chat/completions') {
              return { type: 'chat', model: params.model };
            } else if (path === '/embeddings') {
              return { type: 'embeddings', model: params.model };
            }
          }
        };

        const completions = new Completions(client);
        const embeddings = new Embeddings(client);

        export async function run() {
          const chatResult = await completions.create({ model: 'gpt-4', messages: [] });
          const embeddingResult = await embeddings.create({ model: 'text-embedding-ada-002', input: 'test' });
          return { chatResult, embeddingResult };
        }
      `;

      const entryPoint = path.join(testFilesDir, "multi-class-test.mjs");
      const outfile = path.join(outputDir, "multi-class-bundle.mjs");

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

      await new Promise((resolve) => setImmediate(resolve));

      // Verify both methods executed correctly
      expect(result.chatResult.type).toBe("chat");
      expect(result.embeddingResult.type).toBe("embeddings");

      // Verify chat completions channel received events
      expect(chatCollector.start.length).toBeGreaterThan(0);
      expect(chatCollector.start[0].arguments![0].model).toBe("gpt-4");

      // Verify embeddings channel received events
      expect(embeddingsCollector.start.length).toBeGreaterThan(0);
      expect(embeddingsCollector.start[0].arguments![0].model).toBe(
        "text-embedding-ada-002",
      );
    });

    it("should not cross-contaminate events between channels", async () => {
      const chatCollector = createEventCollector();
      chatCollector.subscribe("orchestrion:openai:chat.completions.create");

      const embeddingsCollector = createEventCollector();
      embeddingsCollector.subscribe("orchestrion:openai:embeddings.create");

      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';
        import { Embeddings } from 'openai/resources/embeddings.mjs';

        const client = {
          post: async (path, params) => ({ path, model: params.model })
        };

        const completions = new Completions(client);
        const embeddings = new Embeddings(client);

        export async function run() {
          // Call only chat completions
          await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(
        testFilesDir,
        "no-cross-contamination-test.mjs",
      );
      const outfile = path.join(outputDir, "no-cross-contamination-bundle.mjs");

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

      // Chat completions channel should have events
      expect(chatCollector.start.length).toBeGreaterThan(0);

      // Embeddings channel should NOT have events (we didn't call it)
      expect(embeddingsCollector.start.length).toBe(0);
      expect(embeddingsCollector.end.length).toBe(0);
      expect(embeddingsCollector.asyncEnd.length).toBe(0);
    });
  });

  describe("Multiple calls to different instrumented methods", () => {
    it("should track each method call independently", async () => {
      const chatCollector = createEventCollector();
      chatCollector.subscribe("orchestrion:openai:chat.completions.create");

      const embeddingsCollector = createEventCollector();
      embeddingsCollector.subscribe("orchestrion:openai:embeddings.create");

      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';
        import { Embeddings } from 'openai/resources/embeddings.mjs';

        const client = {
          post: async (path, params) => ({ path, model: params.model })
        };

        const completions = new Completions(client);
        const embeddings = new Embeddings(client);

        export async function run() {
          // Multiple calls to each
          await completions.create({ model: 'gpt-4', messages: [] });
          await embeddings.create({ model: 'ada-002', input: 'first' });
          await completions.create({ model: 'gpt-3.5-turbo', messages: [] });
          await embeddings.create({ model: 'ada-003', input: 'second' });
          await completions.create({ model: 'gpt-4-turbo', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "multi-calls-test.mjs");
      const outfile = path.join(outputDir, "multi-calls-bundle.mjs");

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

      // Verify correct number of calls to each method
      expect(chatCollector.start.length).toBe(3);
      expect(embeddingsCollector.start.length).toBe(2);

      // Verify the right models were passed
      expect(chatCollector.start[0].arguments![0].model).toBe("gpt-4");
      expect(chatCollector.start[1].arguments![0].model).toBe("gpt-3.5-turbo");
      expect(chatCollector.start[2].arguments![0].model).toBe("gpt-4-turbo");

      expect(embeddingsCollector.start[0].arguments![0].model).toBe("ada-002");
      expect(embeddingsCollector.start[1].arguments![0].model).toBe("ada-003");
    });
  });

  describe("Interleaved async calls", () => {
    it("should handle interleaved async calls to different methods", async () => {
      const chatCollector = createEventCollector();
      chatCollector.subscribe("orchestrion:openai:chat.completions.create");

      const embeddingsCollector = createEventCollector();
      embeddingsCollector.subscribe("orchestrion:openai:embeddings.create");

      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';
        import { Embeddings } from 'openai/resources/embeddings.mjs';

        let callOrder = [];

        const client = {
          post: async (path, params) => {
            const delay = Math.random() * 10;
            await new Promise(resolve => setTimeout(resolve, delay));
            callOrder.push({ path, model: params.model || params.input });
            return { path, model: params.model || params.input };
          }
        };

        const completions = new Completions(client);
        const embeddings = new Embeddings(client);

        export async function run() {
          // Start all calls concurrently
          const promises = [
            completions.create({ model: 'gpt-4', messages: [] }),
            embeddings.create({ input: 'embed1' }),
            completions.create({ model: 'gpt-3.5', messages: [] }),
            embeddings.create({ input: 'embed2' }),
          ];

          await Promise.all(promises);
          return callOrder;
        }
      `;

      const entryPoint = path.join(testFilesDir, "interleaved-test.mjs");
      const outfile = path.join(outputDir, "interleaved-bundle.mjs");

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
      const callOrder = await bundled.run();

      await new Promise((resolve) => setImmediate(resolve));

      // Verify all calls completed
      expect(callOrder).toHaveLength(4);

      // Verify we got events for all calls
      expect(chatCollector.start.length).toBe(2);
      expect(embeddingsCollector.start.length).toBe(2);

      // Verify the events contain the right data (order may vary due to random delays)
      const chatModels = chatCollector.start
        .map((e) => e.arguments![0].model)
        .sort();
      expect(chatModels).toEqual(["gpt-3.5", "gpt-4"]);

      const embedInputs = embeddingsCollector.start
        .map((e) => e.arguments![0].input)
        .sort();
      expect(embedInputs).toEqual(["embed1", "embed2"]);
    });
  });

  describe("Custom instrumentation configs", () => {
    it("should support adding custom instrumentation configs via plugin options", async () => {
      // Create a mock custom SDK module
      const customSdkDir = path.join(nodeModulesDir, "custom-sdk");
      fs.mkdirSync(customSdkDir, { recursive: true });

      fs.writeFileSync(
        path.join(customSdkDir, "package.json"),
        JSON.stringify({ name: "custom-sdk", version: "1.0.0" }),
      );

      fs.writeFileSync(
        path.join(customSdkDir, "index.mjs"),
        `export class CustomAPI {
  constructor(config) {
    this.config = config;
  }

  async process(params) {
    return this.config.handler(params);
  }
}`,
      );

      const customCollector = createEventCollector();
      customCollector.subscribe("orchestrion:custom-sdk:process");

      const testCode = `
        import { CustomAPI } from 'custom-sdk/index.mjs';

        const api = new CustomAPI({
          handler: async (params) => ({ processed: params.data })
        });

        export async function run() {
          return await api.process({ data: 'test' });
        }
      `;

      const entryPoint = path.join(
        testFilesDir,
        "custom-instrumentation-test.mjs",
      );
      const outfile = path.join(outputDir, "custom-instrumentation-bundle.mjs");

      fs.writeFileSync(entryPoint, testCode);

      const { esbuildPlugin } =
        await import("../../src/auto-instrumentations/bundler/esbuild.js");

      // Add custom instrumentation config
      const customConfig = {
        channelName: "process",
        module: {
          name: "custom-sdk",
          versionRange: ">=1.0.0",
          filePath: "index.mjs",
        },
        functionQuery: {
          className: "CustomAPI",
          methodName: "process",
          kind: "Async" as const,
        },
      };

      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        write: true,
        outfile,
        format: "esm",
        plugins: [
          esbuildPlugin({
            browser: false,
            instrumentations: [customConfig],
          }),
        ],
        logLevel: "error",
        absWorkingDir: fixturesDir,
        preserveSymlinks: true,
        platform: "node",
      });

      const bundled = await import(outfile);
      const result = await bundled.run();

      await new Promise((resolve) => setImmediate(resolve));

      // Verify execution worked
      expect(result.processed).toBe("test");

      // Verify custom instrumentation emitted events
      expect(customCollector.start.length).toBeGreaterThan(0);
      expect(customCollector.start[0].arguments![0].data).toBe("test");

      // Clean up
      fs.rmSync(customSdkDir, { recursive: true, force: true });
    });
  });

  describe("Same class, multiple instances", () => {
    it("should instrument calls on different instances of the same class", async () => {
      const collector = createEventCollector();
      collector.subscribe("orchestrion:openai:chat.completions.create");

      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const client1 = {
          name: 'client1',
          post: async (path, params) => ({ client: 'client1', model: params.model })
        };

        const client2 = {
          name: 'client2',
          post: async (path, params) => ({ client: 'client2', model: params.model })
        };

        const completions1 = new Completions(client1);
        const completions2 = new Completions(client2);

        export async function run() {
          const result1 = await completions1.create({ model: 'gpt-4', messages: [] });
          const result2 = await completions2.create({ model: 'gpt-3.5-turbo', messages: [] });
          return { result1, result2 };
        }
      `;

      const entryPoint = path.join(testFilesDir, "multiple-instances-test.mjs");
      const outfile = path.join(outputDir, "multiple-instances-bundle.mjs");

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
      const { result1, result2 } = await bundled.run();

      await new Promise((resolve) => setImmediate(resolve));

      // Verify both calls worked with correct clients
      expect(result1.client).toBe("client1");
      expect(result2.client).toBe("client2");

      // Verify both calls emitted events
      expect(collector.start.length).toBe(2);

      // Verify each call had the right self context
      expect(collector.start[0].self._client.name).toBe("client1");
      expect(collector.start[1].self._client.name).toBe("client2");
    });
  });
});
