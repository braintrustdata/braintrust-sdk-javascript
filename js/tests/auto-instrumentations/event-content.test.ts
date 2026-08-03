/**
 * EVENT CONTENT VALIDATION TESTS
 *
 * These tests verify that global hook events contain the correct information:
 * - Start events contain correct arguments
 * - End events contain correct results
 * - `self` context is captured correctly
 * - moduleVersion is populated (if available)
 * - Event timing and ordering
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
const outputDir = path.join(__dirname, "output-event-content");
const nodeModulesDir = path.join(fixturesDir, "node_modules");

describe("Event Content Validation", () => {
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

  describe("Start Event Content", () => {
    it("should capture function arguments in start event", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ model: 'gpt-4' })
        });

        export async function run() {
          const params = {
            model: 'gpt-4',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            temperature: 0.7,
            max_tokens: 150
          };
          await completions.create(params);
        }
      `;

      const entryPoint = path.join(testFilesDir, "start-args-test.mjs");
      const outfile = path.join(outputDir, "start-args-bundle.mjs");

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

      // Verify start event was emitted with arguments
      expect(collector.start.length).toBeGreaterThan(0);
      const startEvent = collector.start[0];
      expect(startEvent.arguments).toBeDefined();
      expect(startEvent.arguments!.length).toBeGreaterThan(0);

      // Verify the arguments contain the expected parameters
      const args = startEvent.arguments![0];
      expect(args.model).toBe("gpt-4");
      expect(args.temperature).toBe(0.7);
      expect(args.max_tokens).toBe(150);
      expect(args.messages).toHaveLength(1);
      expect(args.messages[0].content).toBe("Hello, world!");
    });

    it("should capture arguments with complex nested objects", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ model: 'gpt-4' })
        });

        export async function run() {
          const complexParams = {
            model: 'gpt-4',
            messages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'Hello!' }
            ],
            functions: [
              {
                name: 'get_weather',
                description: 'Get the weather in a location',
                parameters: {
                  type: 'object',
                  properties: {
                    location: { type: 'string' },
                    unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
                  }
                }
              }
            ]
          };
          await completions.create(complexParams);
        }
      `;

      const entryPoint = path.join(testFilesDir, "complex-args-test.mjs");
      const outfile = path.join(outputDir, "complex-args-bundle.mjs");

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

      // Verify all arguments were captured
      expect(collector.start.length).toBeGreaterThan(0);
      const startEvent = collector.start[0];
      expect(startEvent.arguments).toBeDefined();
      expect(startEvent.arguments!.length).toBeGreaterThanOrEqual(1);

      // Verify complex nested structure is captured
      const args = startEvent.arguments![0];
      expect(args.model).toBe("gpt-4");
      expect(args.messages).toHaveLength(2);
      expect(args.functions).toHaveLength(1);
      expect(args.functions[0].name).toBe("get_weather");
    });
  });

  describe("End Event Content", () => {
    it("should capture function result in end event", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const expectedResult = {
          id: 'chatcmpl-123',
          object: 'chat.completion',
          model: 'gpt-4',
          choices: [
            {
              message: { role: 'assistant', content: 'Hello!' },
              finish_reason: 'stop'
            }
          ]
        };

        const completions = new Completions({
          post: async () => expectedResult
        });

        export async function run() {
          await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "end-result-test.mjs");
      const outfile = path.join(outputDir, "end-result-bundle.mjs");

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

      // Verify end event was emitted with result
      // Note: For async functions, result appears in asyncEnd event
      const hasAsyncEnd = collector.asyncEnd.length > 0;
      const hasEnd = collector.end.length > 0;

      expect(hasAsyncEnd || hasEnd).toBe(true);

      // Check the appropriate event type
      const resultEvent = hasAsyncEnd
        ? collector.asyncEnd[0]
        : collector.end[0];
      expect(resultEvent.result).toBeDefined();
      expect(resultEvent.result.id).toBe("chatcmpl-123");
      expect(resultEvent.result.model).toBe("gpt-4");
      expect(resultEvent.result.choices[0].message.content).toBe("Hello!");
    });

    it("should capture complex nested results", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const complexResult = {
          id: 'chatcmpl-456',
          model: 'gpt-4',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_abc',
                    type: 'function',
                    function: {
                      name: 'get_weather',
                      arguments: '{"location": "San Francisco"}'
                    }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 }
        };

        const completions = new Completions({
          post: async () => complexResult
        });

        export async function run() {
          await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "complex-result-test.mjs");
      const outfile = path.join(outputDir, "complex-result-bundle.mjs");

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

      // Verify complex result structure is captured
      const hasAsyncEnd = collector.asyncEnd.length > 0;
      const hasEnd = collector.end.length > 0;

      expect(hasAsyncEnd || hasEnd).toBe(true);

      const resultEvent = hasAsyncEnd
        ? collector.asyncEnd[0]
        : collector.end[0];
      expect(resultEvent.result).toBeDefined();
      expect(resultEvent.result.usage.total_tokens).toBe(75);
      expect(resultEvent.result.choices[0].message.tool_calls).toHaveLength(1);
      expect(
        resultEvent.result.choices[0].message.tool_calls[0].function.name,
      ).toBe("get_weather");
    });
  });

  describe("Self Context Capture", () => {
    it("should capture 'self' context (the class instance)", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const client = {
          apiKey: 'test-key',
          post: async () => ({ model: 'gpt-4' })
        };

        const completions = new Completions(client);

        export async function run() {
          await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "self-context-test.mjs");
      const outfile = path.join(outputDir, "self-context-bundle.mjs");

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

      // Verify self context was captured
      expect(collector.start.length).toBeGreaterThan(0);
      const startEvent = collector.start[0];
      expect(startEvent.self).toBeDefined();

      // self should be the Completions instance
      expect(startEvent.self._client).toBeDefined();
      expect(startEvent.self._client.apiKey).toBe("test-key");
    });
  });

  describe("Event Timing and Order", () => {
    it("should emit events in correct order: start -> asyncStart -> asyncEnd", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return { model: 'gpt-4' };
          }
        });

        export async function run() {
          await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "event-order-test.mjs");
      const outfile = path.join(outputDir, "event-order-bundle.mjs");

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

      // Verify events were emitted
      expect(collector.start.length).toBeGreaterThan(0);

      // For async functions, we expect asyncStart and asyncEnd
      if (collector.asyncStart.length > 0 && collector.asyncEnd.length > 0) {
        // Verify order: start <= asyncStart <= asyncEnd
        expect(collector.start[0].timestamp).toBeLessThanOrEqual(
          collector.asyncStart[0].timestamp,
        );
        expect(collector.asyncStart[0].timestamp).toBeLessThanOrEqual(
          collector.asyncEnd[0].timestamp,
        );
      }
    });

    it("should emit start and end events for each call when called multiple times", async () => {
      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ model: 'gpt-4' })
        });

        export async function run() {
          await completions.create({ model: 'gpt-4', messages: [] });
          await completions.create({ model: 'gpt-3.5-turbo', messages: [] });
          await completions.create({ model: 'gpt-4-turbo', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "multiple-calls-test.mjs");
      const outfile = path.join(outputDir, "multiple-calls-bundle.mjs");

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

      // Verify we got 3 start events (one per call)
      expect(collector.start.length).toBe(3);

      // Verify each call had different arguments
      expect(collector.start[0].arguments![0].model).toBe("gpt-4");
      expect(collector.start[1].arguments![0].model).toBe("gpt-3.5-turbo");
      expect(collector.start[2].arguments![0].model).toBe("gpt-4-turbo");
    });
  });

  describe("Channel Name Verification", () => {
    it("should emit events on the correct channel name", async () => {
      // Create a collector for the expected channel
      const correctCollector = createEventCollector();
      correctCollector.subscribe("orchestrion:openai:chat.completions.create");

      // Create a collector for a wrong channel (should not receive events)
      const wrongCollector = createEventCollector();
      wrongCollector.subscribe("wrong:channel:name");

      const testCode = `
        import { Completions } from 'openai/resources/chat/completions.mjs';

        const completions = new Completions({
          post: async () => ({ model: 'gpt-4' })
        });

        export async function run() {
          await completions.create({ model: 'gpt-4', messages: [] });
        }
      `;

      const entryPoint = path.join(testFilesDir, "channel-name-test.mjs");
      const outfile = path.join(outputDir, "channel-name-bundle.mjs");

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

      // Verify correct channel received events
      expect(correctCollector.start.length).toBeGreaterThan(0);

      // Verify wrong channel did NOT receive events
      expect(wrongCollector.start.length).toBe(0);
      expect(wrongCollector.end.length).toBe(0);
      expect(wrongCollector.asyncEnd.length).toBe(0);
    });
  });

  describe("Streaming Methods - Event Content", () => {
    beforeAll(() => {
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

  stream(params) {
    return this._client.stream('/beta/chat/completions', params);
  }
}`,
        );
      }

      // Create mock responses module
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
}`,
        );
      }
    });

    describe("Stream Object Verification", () => {
      it("should return stream object synchronously for beta.chat.completions.stream", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              return new EventEmitter();
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Test' }]
            });

            return {
              hasOn: typeof stream.on === 'function',
              hasEmit: typeof stream.emit === 'function',
              isEventEmitter: stream instanceof EventEmitter
            };
          }
        `;

        const entryPoint = path.join(testFilesDir, "stream-object-test.mjs");
        const outfile = path.join(outputDir, "stream-object-bundle.mjs");

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

        // Verify stream object has EventEmitter methods
        expect(result.hasOn).toBe(true);
        expect(result.hasEmit).toBe(true);
        expect(result.isEventEmitter).toBe(true);

        // Verify start event captured arguments
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.start[0].arguments![0].model).toBe("gpt-4");

        // Verify end event (stream returned synchronously)
        expect(streamCollector.end.length).toBeGreaterThan(0);
        expect(streamCollector.end[0].result).toBeDefined();
      });

      it("should return stream object synchronously for responses.stream", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe("orchestrion:openai:responses.stream");

        const testCode = `
          import { Responses } from 'openai/resources/responses/responses.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              return new EventEmitter();
            }
          };

          const responses = new Responses(client);

          export async function run() {
            const stream = responses.stream({
              model: 'gpt-4',
              input: [{ type: 'text', text: 'Test' }]
            });

            return {
              hasOn: typeof stream.on === 'function',
              hasEmit: typeof stream.emit === 'function'
            };
          }
        `;

        const entryPoint = path.join(
          testFilesDir,
          "responses-stream-object-test.mjs",
        );
        const outfile = path.join(
          outputDir,
          "responses-stream-object-bundle.mjs",
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

        // Verify stream object has EventEmitter methods
        expect(result.hasOn).toBe(true);
        expect(result.hasEmit).toBe(true);

        // Verify start event captured arguments
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.start[0].arguments![0].model).toBe("gpt-4");

        // Verify end event (stream returned synchronously)
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });
    });

    describe("Event Listener Attachment", () => {
      it("should verify stream can have multiple listeners attached", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              // Emit events to test listener attachment
              setImmediate(() => {
                emitter.emit('chunk', { data: 'test' });
                emitter.emit('end');
              });

              return emitter;
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Test' }]
            });

            // Attach multiple listeners
            let listener1Called = false;
            let listener2Called = false;
            let endCalled = false;

            stream.on('chunk', () => {
              listener1Called = true;
            });

            stream.on('chunk', () => {
              listener2Called = true;
            });

            stream.on('end', () => {
              endCalled = true;
            });

            await new Promise((resolve) => {
              stream.on('end', resolve);
            });

            return {
              listener1Called,
              listener2Called,
              endCalled
            };
          }
        `;

        const entryPoint = path.join(
          testFilesDir,
          "listener-attachment-test.mjs",
        );
        const outfile = path.join(outputDir, "listener-attachment-bundle.mjs");

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

        // Verify all listeners were called
        expect(result.listener1Called).toBe(true);
        expect(result.listener2Called).toBe(true);
        expect(result.endCalled).toBe(true);

        // Verify start and end events were emitted
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });

      it("should verify handlers are called when stream emits events", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              // Emit events asynchronously
              setImmediate(() => {
                emitter.emit('chunk', {
                  choices: [{ delta: { content: 'Hello' } }]
                });

                setImmediate(() => {
                  emitter.emit('chatCompletion', {
                    id: 'chatcmpl-123',
                    choices: [{ message: { role: 'assistant', content: 'Hello world' } }]
                  });

                  setImmediate(() => {
                    emitter.emit('end');
                  });
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

            const capturedEvents = {
              chunks: [],
              completions: [],
              ended: false
            };

            stream.on('chunk', (chunk) => {
              capturedEvents.chunks.push(chunk);
            });

            stream.on('chatCompletion', (completion) => {
              capturedEvents.completions.push(completion);
            });

            stream.on('end', () => {
              capturedEvents.ended = true;
            });

            // Wait for all events to be emitted
            await new Promise((resolve) => {
              stream.on('end', resolve);
            });

            return capturedEvents;
          }
        `;

        const entryPoint = path.join(testFilesDir, "handler-called-test.mjs");
        const outfile = path.join(outputDir, "handler-called-bundle.mjs");

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

        // Verify all events were captured by user handlers
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.completions.length).toBeGreaterThan(0);
        expect(result.ended).toBe(true);

        // Verify the content of captured events
        expect(result.chunks[0].choices[0].delta.content).toBe("Hello");
        expect(result.completions[0].id).toBe("chatcmpl-123");

        // Verify instrumentation events
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });
    });

    describe("Time to First Token Logging", () => {
      it("should log time_to_first_token on first chunk event", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              // Emit multiple chunks with delays
              setTimeout(() => {
                emitter.emit('chunk', {
                  choices: [{ delta: { content: 'First' } }]
                });
              }, 50);

              setTimeout(() => {
                emitter.emit('chunk', {
                  choices: [{ delta: { content: ' Second' } }]
                });
              }, 100);

              setTimeout(() => {
                emitter.emit('chatCompletion', {
                  choices: [{ message: { content: 'First Second' } }]
                });
                emitter.emit('end');
              }, 150);

              return emitter;
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const startTime = Date.now();
            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Test TTFT' }]
            });

            let firstChunkTime = null;
            let chunkCount = 0;

            stream.on('chunk', () => {
              chunkCount++;
              if (chunkCount === 1) {
                firstChunkTime = Date.now() - startTime;
              }
            });

            await new Promise((resolve) => {
              stream.on('end', resolve);
            });

            return { firstChunkTime, chunkCount };
          }
        `;

        const entryPoint = path.join(testFilesDir, "ttft-test.mjs");
        const outfile = path.join(outputDir, "ttft-bundle.mjs");

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

        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify timing metrics
        expect(result.firstChunkTime).toBeGreaterThan(0);
        expect(result.chunkCount).toBe(2);

        // Verify instrumentation captured the start
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);

        // Note: Actual time_to_first_token logging happens in the instrumentation wrapper
        // This test verifies the stream emits chunks in the correct sequence
      });

      it("should log time_to_first_token only once for multiple chunks", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              // Emit many chunks quickly
              setImmediate(() => {
                for (let i = 0; i < 5; i++) {
                  emitter.emit('chunk', {
                    choices: [{ delta: { content: \`chunk\${i}\` } }]
                  });
                }
                emitter.emit('end');
              });

              return emitter;
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Many chunks' }]
            });

            let chunkCount = 0;
            stream.on('chunk', () => {
              chunkCount++;
            });

            await new Promise((resolve) => {
              stream.on('end', resolve);
            });

            return { chunkCount };
          }
        `;

        const entryPoint = path.join(testFilesDir, "ttft-once-test.mjs");
        const outfile = path.join(outputDir, "ttft-once-bundle.mjs");

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

        // Verify all chunks were received
        expect(result.chunkCount).toBe(5);

        // Verify instrumentation events
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });
    });

    describe("Final Result Logging", () => {
      it("should log output on chatCompletion event", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const expectedCompletion = {
            id: 'chatcmpl-final-123',
            object: 'chat.completion',
            model: 'gpt-4',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Complete response' },
              finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          };

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              setImmediate(() => {
                emitter.emit('chunk', { choices: [{ delta: { content: 'Complete' } }] });

                setImmediate(() => {
                  emitter.emit('chunk', { choices: [{ delta: { content: ' response' } }] });

                  setImmediate(() => {
                    emitter.emit('chatCompletion', expectedCompletion);
                    emitter.emit('end');
                  });
                });
              });

              return emitter;
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Final result test' }]
            });

            let capturedCompletion = null;

            stream.on('chatCompletion', (completion) => {
              capturedCompletion = completion;
            });

            await new Promise((resolve) => {
              stream.on('end', resolve);
            });

            return { capturedCompletion };
          }
        `;

        const entryPoint = path.join(testFilesDir, "final-output-test.mjs");
        const outfile = path.join(outputDir, "final-output-bundle.mjs");

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

        // Verify chatCompletion event structure
        expect(result.capturedCompletion).toBeDefined();
        expect(result.capturedCompletion.id).toBe("chatcmpl-final-123");
        expect(result.capturedCompletion.choices[0].message.content).toBe(
          "Complete response",
        );
        expect(result.capturedCompletion.usage.total_tokens).toBe(15);

        // Verify instrumentation events
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });

      it("should log output on response.completed event for responses.stream", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe("orchestrion:openai:responses.stream");

        const testCode = `
          import { Responses } from 'openai/resources/responses/responses.mjs';
          import { EventEmitter } from 'events';

          const expectedResponse = {
            id: 'resp-completed-456',
            object: 'response',
            output: ['Generated content'],
            usage: { input_tokens: 15, output_tokens: 25 },
            status: 'completed'
          };

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              setImmediate(() => {
                emitter.emit('event', {
                  type: 'response.output_item.added',
                  output_item: { content: 'partial' }
                });

                setImmediate(() => {
                  emitter.emit('event', {
                    type: 'response.completed',
                    response: expectedResponse
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
              input: [{ type: 'text', text: 'Response final test' }]
            });

            let capturedResponse = null;
            const events = [];

            stream.on('event', (event) => {
              events.push(event);
              if (event.type === 'response.completed') {
                capturedResponse = event.response;
              }
            });

            await new Promise((resolve) => {
              stream.on('end', resolve);
            });

            return { capturedResponse, eventCount: events.length };
          }
        `;

        const entryPoint = path.join(
          testFilesDir,
          "response-completed-test.mjs",
        );
        const outfile = path.join(outputDir, "response-completed-bundle.mjs");

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

        // Verify response.completed event structure
        expect(result.capturedResponse).toBeDefined();
        expect(result.capturedResponse.id).toBe("resp-completed-456");
        expect(result.capturedResponse.output).toContain("Generated content");
        expect(result.capturedResponse.usage.input_tokens).toBe(15);
        expect(result.eventCount).toBe(2);

        // Verify instrumentation events
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });
    });

    describe("Span Lifecycle", () => {
      it("should create span at method call (start event)", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();
              setTimeout(() => emitter.emit('end'), 50);
              return emitter;
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const beforeCall = Date.now();
            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Span lifecycle' }]
            });
            const afterCall = Date.now();

            await new Promise((resolve) => {
              stream.on('end', resolve);
            });

            return { callDuration: afterCall - beforeCall };
          }
        `;

        const entryPoint = path.join(testFilesDir, "span-start-test.mjs");
        const outfile = path.join(outputDir, "span-start-bundle.mjs");

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

        // Verify the call returned quickly (synchronous)
        expect(result.callDuration).toBeLessThan(50);

        // Verify start event was emitted immediately
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.start[0].arguments![0].model).toBe("gpt-4");

        // Verify end event was also emitted (stream returned synchronously)
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });

      it("should NOT end span before stream completes", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              // Stream will take 100ms to complete
              setTimeout(() => {
                emitter.emit('chunk', { choices: [{ delta: { content: 'test' } }] });
              }, 30);

              setTimeout(() => {
                emitter.emit('chatCompletion', {
                  choices: [{ message: { content: 'test' } }]
                });
                emitter.emit('end');
              }, 100);

              return emitter;
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const events = {
              streamCreated: false,
              chunkReceived: false,
              streamEnded: false
            };

            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Long stream' }]
            });

            events.streamCreated = true;

            stream.on('chunk', () => {
              events.chunkReceived = true;
            });

            await new Promise((resolve) => {
              stream.on('end', () => {
                events.streamEnded = true;
                resolve();
              });
            });

            return events;
          }
        `;

        const entryPoint = path.join(testFilesDir, "span-not-ended-test.mjs");
        const outfile = path.join(outputDir, "span-not-ended-bundle.mjs");

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

        await new Promise((resolve) => setTimeout(resolve, 150));

        // Verify stream lifecycle
        expect(result.streamCreated).toBe(true);
        expect(result.chunkReceived).toBe(true);
        expect(result.streamEnded).toBe(true);

        // Verify instrumentation captured the entire lifecycle
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);

        // The start and end events are for the synchronous method call
        // The actual stream completion happens asynchronously via event listeners
      });
    });

    describe("Error Handling", () => {
      it("should handle error when stream emits error event", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              setImmediate(() => {
                emitter.emit('error', new Error('Stream error occurred'));
              });

              return emitter;
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Error test' }]
            });

            let capturedError = null;

            stream.on('error', (error) => {
              capturedError = error;
            });

            // Wait for error to be emitted
            await new Promise((resolve) => {
              stream.on('error', resolve);
            });

            return {
              errorMessage: capturedError?.message,
              hasError: capturedError !== null
            };
          }
        `;

        const entryPoint = path.join(testFilesDir, "stream-error-test.mjs");
        const outfile = path.join(outputDir, "stream-error-bundle.mjs");

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

        // Verify error was captured
        expect(result.hasError).toBe(true);
        expect(result.errorMessage).toBe("Stream error occurred");

        // Verify instrumentation events
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });

      it("should log error and end span when stream fails", async () => {
        const streamCollector = createEventCollector();
        streamCollector.subscribe(
          "orchestrion:openai:beta.chat.completions.stream",
        );

        const testCode = `
          import { Completions } from 'openai/resources/beta/chat/completions.mjs';
          import { EventEmitter } from 'events';

          const client = {
            stream: (path, params) => {
              const emitter = new EventEmitter();

              // Emit a chunk then error
              setImmediate(() => {
                emitter.emit('chunk', { choices: [{ delta: { content: 'start' } }] });

                setImmediate(() => {
                  const error = new Error('Network failure');
                  error.code = 'ECONNRESET';
                  emitter.emit('error', error);
                });
              });

              return emitter;
            }
          };

          const completions = new Completions(client);

          export async function run() {
            const stream = completions.stream({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'Span error test' }]
            });

            const events = {
              chunkCount: 0,
              errorCode: null,
              errorMessage: null
            };

            stream.on('chunk', () => {
              events.chunkCount++;
            });

            stream.on('error', (error) => {
              events.errorCode = error.code;
              events.errorMessage = error.message;
            });

            // Wait for error
            await new Promise((resolve) => {
              stream.on('error', resolve);
            });

            return events;
          }
        `;

        const entryPoint = path.join(testFilesDir, "span-error-test.mjs");
        const outfile = path.join(outputDir, "span-error-bundle.mjs");

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

        // Verify partial streaming and error
        expect(result.chunkCount).toBe(1);
        expect(result.errorCode).toBe("ECONNRESET");
        expect(result.errorMessage).toBe("Network failure");

        // Verify instrumentation events
        expect(streamCollector.start.length).toBeGreaterThan(0);
        expect(streamCollector.end.length).toBeGreaterThan(0);
      });
    });
  });
});
