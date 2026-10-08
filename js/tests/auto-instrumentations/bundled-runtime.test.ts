/**
 * BUNDLED RUNTIME TESTS
 *
 * These tests execute bundler output built against the mock OpenAI package in
 * fixtures/node_modules and verify that transformed methods:
 * - Preserve arguments, receivers, return values, errors, and stream objects
 * - Emit the expected global hook lifecycle on the configured channel
 *
 * Hook lifecycle semantics themselves are covered by
 * src/global-instrumentation-hooks.test.ts; transformed output shape is covered
 * by transformation.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as esbuild from "esbuild";
import { build as viteBuild } from "vite";
import { rollup } from "rollup";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  newGlobalTracingChannel,
  type GlobalHookHandlers,
} from "../../src/global-instrumentation-hooks";
import type { InstrumentationConfig } from "../../src/auto-instrumentations/orchestrion-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");
const testFilesDir = path.join(fixturesDir, "test-files");
const outputDir = path.join(__dirname, "output-bundled-runtime");

const OPENAI_APP = `
  export { Completions } from 'openai/resources/chat/completions.mjs';
  export { Completions as BetaCompletions } from 'openai/resources/beta/chat/completions.mjs';
  export { Embeddings } from 'openai/resources/embeddings.mjs';
  export { Responses } from 'openai/resources/responses/responses.mjs';
`;

const PROMISE_LIFECYCLE = ["start", "end", "asyncStart", "asyncEnd"];
const REJECTION_LIFECYCLE = ["start", "end", "error", "asyncStart", "asyncEnd"];
const SYNC_LIFECYCLE = ["start", "end"];

type Bundler = "esbuild" | "vite" | "rollup";

async function bundle(
  bundler: Bundler,
  name: string,
  code: string,
  {
    instrumentations = [],
    entryDir = testFilesDir,
  }: { instrumentations?: InstrumentationConfig[]; entryDir?: string } = {},
): Promise<any> {
  const entryPoint = path.join(entryDir, `${name}.mjs`);
  fs.writeFileSync(entryPoint, code);
  const outfile = path.join(outputDir, bundler, `${name}.mjs`);

  if (bundler === "esbuild") {
    const { braintrustEsbuildPlugin } =
      await import("../../src/auto-instrumentations/bundler/esbuild.js");
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      write: true,
      outfile,
      format: "esm",
      plugins: [braintrustEsbuildPlugin({ instrumentations })],
      logLevel: "error",
      absWorkingDir: fixturesDir,
      preserveSymlinks: true,
      platform: "node",
    });
  } else if (bundler === "vite") {
    const { braintrustVitePlugin } =
      await import("../../src/auto-instrumentations/bundler/vite.js");
    await viteBuild({
      root: fixturesDir,
      build: {
        lib: { entry: entryPoint, formats: ["es"], fileName: name },
        outDir: path.dirname(outfile),
        emptyOutDir: false,
        minify: false,
      },
      plugins: [braintrustVitePlugin({ instrumentations })],
      logLevel: "error",
      resolve: { preserveSymlinks: true },
    });
  } else {
    const { braintrustRollupPlugin } =
      await import("../../src/auto-instrumentations/bundler/rollup.js");
    const result = await rollup({
      input: entryPoint,
      plugins: [
        {
          name: "resolve-fixture-openai",
          resolveId(source: string) {
            // Bundler resolveId always returns posix-style paths
            return source.startsWith("openai")
              ? path
                  .resolve(fixturesDir, "node_modules", source)
                  .replace(/\\/g, "/")
              : null;
          },
        },
        braintrustRollupPlugin({ instrumentations }),
      ],
      preserveSymlinks: true,
    });
    await result.write({ file: outfile, format: "es" });
    await result.close();
  }

  return import(outfile);
}

type HookEvent = { type: keyof GlobalHookHandlers; context: any };

const unsubscribers: Array<() => void> = [];

function recordChannel(channelName: string): HookEvent[] {
  const events: HookEvent[] = [];
  const channel = newGlobalTracingChannel(channelName);
  const handlers: GlobalHookHandlers = {
    start: (context) => events.push({ type: "start", context }),
    end: (context) => events.push({ type: "end", context }),
    asyncStart: (context) => events.push({ type: "asyncStart", context }),
    asyncEnd: (context) => events.push({ type: "asyncEnd", context }),
    error: (context) => events.push({ type: "error", context }),
  };
  channel.subscribe(handlers);
  unsubscribers.push(() => channel.unsubscribe(handlers));
  return events;
}

function eventTypes(events: HookEvent[]): string[] {
  return events.map((event) => event.type);
}

function startContexts(events: HookEvent[]): any[] {
  return events
    .filter((event) => event.type === "start")
    .map((event) => event.context);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Bundled Runtime", () => {
  let app: any;

  beforeAll(async () => {
    fs.mkdirSync(testFilesDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    app = await bundle("esbuild", "openai-app", OPENAI_APP);
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
  });

  afterAll(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    // Don't clean up test-files to avoid races with other suites using it
  });

  it.each(["esbuild", "vite", "rollup"] as const)(
    "executes instrumented %s output",
    async (bundler) => {
      const events = recordChannel(
        "orchestrion:openai:chat.completions.create",
      );
      const bundled = await bundle(bundler, `${bundler}-exec`, OPENAI_APP);
      const response = { bundler };
      const completions = new bundled.Completions({
        post: async () => response,
      });

      await expect(
        completions.create({ model: "gpt-4", messages: [] }),
      ).resolves.toBe(response);
      expect(eventTypes(events)).toEqual(PROMISE_LIFECYCLE);
    },
  );

  it("preserves arguments, receiver, and resolved value for async methods", async () => {
    const events = recordChannel("orchestrion:openai:chat.completions.create");
    const response = { id: "chatcmpl-123", choices: [] };
    const client = {
      apiKey: "test-key",
      calls: [] as Array<{ path: string; params: unknown }>,
      async post(path: string, params: unknown) {
        this.calls.push({ path, params });
        await delay(5);
        return response;
      },
    };
    const completions = new app.Completions(client);
    const params = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
    };

    const result = await completions
      .create(params)
      .then((value: unknown) => value);

    expect(result).toBe(response);
    expect(client.calls).toEqual([{ path: "/chat/completions", params }]);
    expect(client.calls[0].params).toBe(params);
    expect(eventTypes(events)).toEqual(PROMISE_LIFECYCLE);
    const [{ context }] = events;
    expect(context.arguments[0]).toBe(params);
    expect(context.self).toBe(completions);
    expect(context.result).toBe(response);
  });

  it("propagates rejections unchanged and reports them on the error event", async () => {
    const events = recordChannel("orchestrion:openai:chat.completions.create");
    class CustomAPIError extends Error {
      constructor(
        message: string,
        public readonly status: number,
      ) {
        super(message);
        this.name = "CustomAPIError";
      }
    }
    const error = new CustomAPIError("Invalid API key", 401);
    const completions = new app.Completions({
      post: async () => {
        throw error;
      },
    });

    await expect(
      completions.create({ model: "gpt-4", messages: [] }),
    ).rejects.toBe(error);
    expect(error.stack).toContain("Invalid API key");
    expect(eventTypes(events)).toEqual(REJECTION_LIFECYCLE);
    expect(events[0].context.error).toBe(error);
  });

  it("keeps concurrent calls on separate instances and channels isolated", async () => {
    const chatEvents = recordChannel(
      "orchestrion:openai:chat.completions.create",
    );
    const embeddingEvents = recordChannel(
      "orchestrion:openai:embeddings.create",
    );
    const unrelatedEvents = recordChannel(
      "orchestrion:openai:responses.create",
    );
    const makeClient = (name: string, ms: number) => ({
      post: async (path: string, params: { model: string }) => {
        await delay(ms);
        return { client: name, path, model: params.model };
      },
    });
    const chat1 = new app.Completions(makeClient("client1", 15));
    const chat2 = new app.Completions(makeClient("client2", 5));
    const embeddings = new app.Embeddings(makeClient("client3", 10));

    const results = await Promise.all([
      chat1.create({ model: "gpt-4", messages: [] }),
      embeddings.create({ model: "text-embedding-3-small", input: "hi" }),
      chat2.create({ model: "gpt-4o-mini", messages: [] }),
    ]);

    expect(results).toEqual([
      { client: "client1", path: "/chat/completions", model: "gpt-4" },
      {
        client: "client3",
        path: "/embeddings",
        model: "text-embedding-3-small",
      },
      { client: "client2", path: "/chat/completions", model: "gpt-4o-mini" },
    ]);

    const chatContexts = startContexts(chatEvents);
    expect(chatContexts.map((context) => context.self)).toEqual([chat1, chat2]);
    expect(chatContexts.map((context) => context.result)).toEqual([
      results[0],
      results[2],
    ]);
    expect(startContexts(embeddingEvents).map((c) => c.result)).toEqual([
      results[1],
    ]);
    expect(unrelatedEvents).toEqual([]);
  });

  it.each([
    {
      name: "responses.create",
      channel: "responses.create",
      call: (client: any) =>
        new app.Responses(client).create({ model: "gpt-4", input: "Hi" }),
    },
    {
      name: "responses.create with stream: true",
      channel: "responses.create",
      stream: true,
      call: (client: any) =>
        new app.Responses(client).create({
          model: "gpt-4",
          input: "Hi",
          stream: true,
        }),
    },
    {
      name: "responses.parse",
      channel: "responses.parse",
      call: (client: any) =>
        new app.Responses(client).parse({ model: "gpt-4", input: "Hi" }),
    },
    {
      name: "chat.completions.create with stream: true",
      channel: "chat.completions.create",
      stream: true,
      call: (client: any) =>
        new app.Completions(client).create({
          model: "gpt-4",
          messages: [],
          stream: true,
        }),
    },
    {
      name: "beta.chat.completions.parse",
      channel: "beta.chat.completions.parse",
      call: (client: any) =>
        new app.BetaCompletions(client).parse({ model: "gpt-4", messages: [] }),
    },
  ])(
    "$name resolves to the provider value",
    async ({ channel, stream, call }) => {
      const events = recordChannel(`orchestrion:openai:${channel}`);
      const response = stream
        ? {
            async *[Symbol.asyncIterator]() {
              yield { delta: "Hello" };
              yield { delta: " world" };
            },
          }
        : { output: ["Hello world"] };

      const result = await call({ post: async () => response });

      expect(result).toBe(response);
      if (stream) {
        const chunks = [];
        for await (const chunk of result) {
          chunks.push(chunk);
        }
        expect(chunks).toEqual([{ delta: "Hello" }, { delta: " world" }]);
      }
      expect(eventTypes(events)).toEqual(PROMISE_LIFECYCLE);
      expect(events[0].context.result).toBe(response);
    },
  );

  it.each([
    {
      channel: "beta.chat.completions.stream",
      call: (client: any) =>
        new app.BetaCompletions(client).stream({
          model: "gpt-4",
          messages: [],
        }),
    },
    {
      channel: "responses.stream",
      call: (client: any) =>
        new app.Responses(client).stream({ model: "gpt-4", input: "Hi" }),
    },
  ])(
    "$channel returns the provider stream synchronously",
    async ({ channel, call }) => {
      const events = recordChannel(`orchestrion:openai:${channel}`);
      const emitter = new EventEmitter();

      const stream = call({ stream: () => emitter });

      expect(stream).toBe(emitter);
      expect(eventTypes(events)).toEqual(SYNC_LIFECYCLE);
      expect(events[0].context.result).toBe(emitter);
    },
  );

  it("applies custom instrumentation configs passed to the plugin", async () => {
    // Keep the fake package next to its entry so other suites can't resolve it
    const appDir = path.join(outputDir, "custom-sdk-app");
    const customSdkDir = path.join(appDir, "node_modules", "custom-sdk");
    fs.mkdirSync(customSdkDir, { recursive: true });
    fs.writeFileSync(
      path.join(customSdkDir, "package.json"),
      JSON.stringify({ name: "custom-sdk", version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(customSdkDir, "index.mjs"),
      `export class CustomAPI {
        constructor(handler) { this.handler = handler; }
        async process(params) { return this.handler(params); }
      }`,
    );
    const events = recordChannel("orchestrion:custom-sdk:process");

    const bundled = await bundle(
      "esbuild",
      "custom-instrumentation",
      "export { CustomAPI } from 'custom-sdk/index.mjs';",
      {
        entryDir: appDir,
        instrumentations: [
          {
            channelName: "process",
            module: {
              name: "custom-sdk",
              versionRange: ">=1.0.0",
              filePath: "index.mjs",
            },
            functionQuery: {
              className: "CustomAPI",
              methodName: "process",
              kind: "Async",
            },
          },
        ],
      },
    );
    const api = new bundled.CustomAPI(async (params: { data: string }) => ({
      processed: params.data,
    }));

    await expect(api.process({ data: "test" })).resolves.toEqual({
      processed: "test",
    });
    expect(eventTypes(events)).toEqual(PROMISE_LIFECYCLE);
    expect(events[0].context.arguments[0]).toEqual({ data: "test" });
  });
});
