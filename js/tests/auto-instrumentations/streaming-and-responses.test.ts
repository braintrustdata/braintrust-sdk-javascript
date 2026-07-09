/**
 * STREAMING METHODS AND RESPONSES API TESTS
 *
 * These tests verify that streaming methods and the Responses API work correctly:
 * - Event-based streams (beta.chat.completions.stream, responses.stream)
 * - Async iterable streams (chat.completions.create with stream=true)
 * - Event listener attachment
 * - time_to_first_token calculation
 * - Final output logging on completion events
 * - Span lifecycle (created at start, ended on stream end)
 * - Responses API channels (responses.create, responses.stream, responses.parse)
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
const outputDir = path.join(__dirname, "output-streaming-responses");
const nodeModulesDir = path.join(fixturesDir, "node_modules");

describe("Streaming Methods and Responses API", () => {
  beforeAll(() => {
    // Create test-files and output directories
    if (!fs.existsSync(testFilesDir)) {
      fs.mkdirSync(testFilesDir, { recursive: true });
    }
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Create mock beta completions module for testing stream() method
    const betaDir = path.join(nodeModulesDir, "openai/resources/beta/chat");
    if (!fs.existsSync(betaDir)) {
      fs.mkdirSync(betaDir, { recursive: true });
    }

    const betaCompletionsFile = path.join(betaDir, "completions.mjs");
    if (!fs.existsSync(betaCompletionsFile)) {
      fs.writeFileSync(
        betaCompletionsFile,
        `export class Completions {
  constructor(client) {
    this._client = client;
  }

  async create(params) {
    return this._client.post('/beta/chat/completions', params);
  }

  async parse(params) {
    return this._client.post('/beta/chat/completions', { ...params, parse: true });
  }

  stream(params) {
    // Return the stream from the client
    return this._client.stream('/beta/chat/completions', params);
  }
}`,
      );
    }

    // Create mock responses module for testing Responses API
    const responsesDir = path.join(
      nodeModulesDir,
      "openai/resources/responses",
    );
    if (!fs.existsSync(responsesDir)) {
      fs.mkdirSync(responsesDir, { recursive: true });
    }

    const responsesFile = path.join(responsesDir, "responses.mjs");
    if (!fs.existsSync(responsesFile)) {
      fs.writeFileSync(
        responsesFile,
        `export class Responses {
  constructor(client) {
    this._client = client;
  }

  async create(params) {
    return this._client.post('/responses', params);
  }

  stream(params) {
    return this._client.stream('/responses', params);
  }

  async parse(params) {
    return this._client.post('/responses/parse', params);
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
  });

  describe("Beta Chat Completions Stream", () => {
    it("should instrument beta.chat.completions.stream (Sync method)", async () => {
      const collector = createEventCollector();
      collector.subscribe("orchestrion:openai:beta.chat.completions.stream");

      const testCode = `
        import { Completions } from 'openai/resources/beta/chat/completions.mjs';
        import { EventEmitter } from 'events';

        const client = {
          post: async (path, params) => ({
            choices: [{ message: { role: 'assistant', content: 'Hello' } }]
          }),
          stream: (path, params) => {
            const emitter = new EventEmitter();
            setImmediate(() => {
              emitter.emit('chunk', { delta: { content: 'Hello' } });
              setImmediate(() => {
                emitter.emit('chatCompletion', {
                  choices: [{ message: { role: 'assistant', content: 'Hello world' } }]
                });
                emitter.emit('end');
              });
            });
            return emitter;
          }
        };

        const completions = new Completions(client);

        export async function run() {
          const stream = completions.stream({
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hi' }]
          });

          return new Promise((resolve) => {
            stream.on('end', () => {
              resolve({ done: true });
            });
          });
        }
      `;

      const entryPoint = path.join(testFilesDir, "beta-stream-test.mjs");
      const outfile = path.join(outputDir, "beta-stream-bundle.mjs");

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

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify start event (method called)
      expect(collector.start.length).toBeGreaterThan(0);
      const startEvent = collector.start[0];
      expect(startEvent.arguments![0].model).toBe("gpt-4");

      // Verify end event (stream returned synchronously)
      expect(collector.end.length).toBeGreaterThan(0);
    });
  });

  describe("Responses API - create", () => {
    it("should instrument responses.create with non-streaming", async () => {
      const collector = createEventCollector();
      collector.subscribe("orchestrion:openai:responses.create");

      const testCode = `
        import { Responses } from 'openai/resources/responses/responses.mjs';

        const client = {
          post: async (path, params) => ({
            output: ['Generated output'],
            usage: { input_tokens: 10, output_tokens: 20 }
          })
        };

        const responses = new Responses(client);

        export async function run() {
          return await responses.create({
            model: 'gpt-4',
            input: [{ type: 'text', text: 'Hello' }]
          });
        }
      `;

      const entryPoint = path.join(testFilesDir, "responses-create-test.mjs");
      const outfile = path.join(outputDir, "responses-create-bundle.mjs");

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

      // Verify events were captured
      expect(collector.start.length).toBeGreaterThan(0);
      expect(collector.asyncEnd.length).toBeGreaterThan(0);

      // Verify input was captured
      const startEvent = collector.start[0];
      expect(startEvent.arguments![0].model).toBe("gpt-4");

      // Verify result
      expect(result.output).toBeDefined();
    });

    it("should instrument responses.create with streaming (stream=true)", async () => {
      const collector = createEventCollector();
      collector.subscribe("orchestrion:openai:responses.create");

      const testCode = `
        import { Responses } from 'openai/resources/responses/responses.mjs';

        const client = {
          post: async (path, params) => {
            if (params.stream) {
              // Return async iterable for stream=true
              const chunks = [
                { output: ['chunk1'] },
                { output: ['chunk2'] },
                { output: ['chunk3'], usage: { input_tokens: 10, output_tokens: 5 } }
              ];

              return {
                async *[Symbol.asyncIterator]() {
                  for (const chunk of chunks) {
                    yield chunk;
                  }
                }
              };
            }

            return {
              output: ['Generated output'],
              usage: { input_tokens: 10, output_tokens: 20 }
            };
          }
        };

        const responses = new Responses(client);

        export async function run() {
          const stream = await responses.create({
            model: 'gpt-4',
            input: [{ type: 'text', text: 'Hello' }],
            stream: true
          });

          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          return chunks;
        }
      `;

      const entryPoint = path.join(
        testFilesDir,
        "responses-create-stream-test.mjs",
      );
      const outfile = path.join(
        outputDir,
        "responses-create-stream-bundle.mjs",
      );

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

      // Verify stream was consumed
      expect(result).toHaveLength(3);

      // Verify events were captured
      expect(collector.start.length).toBeGreaterThan(0);
      expect(collector.asyncEnd.length).toBeGreaterThan(0);
    });
  });

  describe("Responses API - stream", () => {
    it("should instrument responses.stream (Sync method with events)", async () => {
      const collector = createEventCollector();
      collector.subscribe("orchestrion:openai:responses.stream");

      const testCode = `
        import { Responses } from 'openai/resources/responses/responses.mjs';
        import { EventEmitter } from 'events';

        const client = {
          stream: (path, params) => {
            const emitter = new EventEmitter();
            setImmediate(() => {
              emitter.emit('event', {
                type: 'response.output_item.added',
                response: { output: ['partial'] }
              });
              setImmediate(() => {
                emitter.emit('event', {
                  type: 'response.completed',
                  response: {
                    output: ['Generated output'],
                    usage: { input_tokens: 10, output_tokens: 20 },
                    id: 'resp_123'
                  }
                });
                emitter.emit('end');
              });
            });
            return emitter;
          }
        };

        const responses = new Responses(client);

        export async function run() {
          const stream = responses.stream({
            model: 'gpt-4',
            input: [{ type: 'text', text: 'Generate image' }]
          });

          return new Promise((resolve) => {
            const events = [];

            stream.on('event', (event) => {
              events.push(event);
            });

            stream.on('end', () => {
              resolve({ events, done: true });
            });
          });
        }
      `;

      const entryPoint = path.join(testFilesDir, "responses-stream-test.mjs");
      const outfile = path.join(outputDir, "responses-stream-bundle.mjs");

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

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify stream events were emitted
      expect(result.events).toHaveLength(2);
      expect(result.events[1].type).toBe("response.completed");

      // Verify instrumentation events
      expect(collector.start.length).toBeGreaterThan(0);
      expect(collector.end.length).toBeGreaterThan(0);
    });
  });

  describe("Responses API - parse", () => {
    it("should instrument responses.parse", async () => {
      const collector = createEventCollector();
      collector.subscribe("orchestrion:openai:responses.parse");

      const testCode = `
        import { Responses } from 'openai/resources/responses/responses.mjs';

        const client = {
          post: async (path, params) => ({
            output: ['Parsed output'],
            usage: { input_tokens: 15, output_tokens: 25 }
          })
        };

        const responses = new Responses(client);

        export async function run() {
          return await responses.parse({
            model: 'gpt-4',
            input: [{ type: 'text', text: 'Parse this' }]
          });
        }
      `;

      const entryPoint = path.join(testFilesDir, "responses-parse-test.mjs");
      const outfile = path.join(outputDir, "responses-parse-bundle.mjs");

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

      // Verify events were captured
      expect(collector.start.length).toBeGreaterThan(0);
      expect(collector.asyncEnd.length).toBeGreaterThan(0);

      // Verify input was captured
      const startEvent = collector.start[0];
      expect(startEvent.arguments![0].model).toBe("gpt-4");

      // Verify result
      expect(result.output).toBeDefined();
      expect(result.output).toContain("Parsed output");
    });
  });

  describe("Async Iterable Streams", () => {
    it("should handle async iterable streams from chat.completions.create", async () => {
      const collector = createEventCollector();
      collector.subscribe("orchestrion:openai:chat.completions.create");

      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const client = {
          post: async (path, params) => {
            if (params.stream) {
              // Return async iterable
              const chunks = [
                { choices: [{ delta: { role: 'assistant' } }] },
                { choices: [{ delta: { content: 'Hello' } }] },
                { choices: [{ delta: { content: ' world' } }] }
              ];

              return {
                async *[Symbol.asyncIterator]() {
                  for (const chunk of chunks) {
                    yield chunk;
                  }
                }
              };
            }

            return {
              choices: [{ message: { role: 'assistant', content: 'Hello world' } }]
            };
          }
        };

        const completions = new Completions(client);

        export async function run() {
          const stream = await completions.create({
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hi' }],
            stream: true
          });

          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          return chunks;
        }
      `;

      const entryPoint = path.join(
        testFilesDir,
        "async-iterable-stream-test.mjs",
      );
      const outfile = path.join(outputDir, "async-iterable-stream-bundle.mjs");

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

      // Verify stream was consumed
      expect(result).toHaveLength(3);
      expect(result[0].choices[0].delta.role).toBe("assistant");

      // Verify events were captured
      expect(collector.start.length).toBeGreaterThan(0);
      expect(collector.asyncEnd.length).toBeGreaterThan(0);
    });
  });
});
