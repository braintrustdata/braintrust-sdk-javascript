/**
 * BUNDLED RUNTIME TESTS
 *
 * These tests execute bundler output built against the mock packages in
 * fixtures/node_modules and verify that transformed methods:
 * - Preserve arguments, receivers, return values, errors, and stream objects
 * - Emit the expected global hook lifecycle on the configured channel
 *
 * Hook lifecycle semantics themselves are covered by
 * src/global-instrumentation-hooks.test.ts; transformed output shape is covered
 * by transformation.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  newGlobalTracingChannel,
  type GlobalHookHandlers,
} from "../../src/global-instrumentation-hooks";
import type { BundlerPluginOptions } from "../../src/auto-instrumentations/bundler/plugin";
import { bundleFixture, fixturesDir, type Bundler } from "./test-bundle";

const outputDir = fileURLToPath(
  new URL("output-bundled-runtime", import.meta.url),
);
const openAIApp = path.join(fixturesDir, "openai-app.mjs");

const PROMISE_LIFECYCLE = ["start", "end", "asyncStart", "asyncEnd"];
const REJECTION_LIFECYCLE = ["start", "end", "error", "asyncStart", "asyncEnd"];
const SYNC_LIFECYCLE = ["start", "end"];

async function bundle(
  bundler: Bundler,
  entryPoint: string,
  options?: BundlerPluginOptions,
): Promise<any> {
  const outfile = path.join(outputDir, bundler, path.basename(entryPoint));
  await bundleFixture(bundler, entryPoint, outfile, options);
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
  // Most tests run against esbuild output; vite and rollup get a smoke test.
  let app: any;

  beforeAll(async () => {
    app = await bundle("esbuild", openAIApp);
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
  });

  afterAll(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it.each(["vite", "rollup"] as const)(
    "executes instrumented %s output",
    async (bundler) => {
      const events = recordChannel(
        "orchestrion:openai:chat.completions.create",
      );
      const bundled = await bundle(bundler, openAIApp);
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

    const result = await completions.create(params);

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
    const error = new Error("Invalid API key");
    const completions = new app.Completions({
      post: async () => {
        throw error;
      },
    });

    await expect(
      completions.create({ model: "gpt-4", messages: [] }),
    ).rejects.toBe(error);
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
      channel: "responses.create",
      stream: false,
      call: (client: any, params: object) =>
        new app.Responses(client).create(params),
    },
    {
      channel: "responses.create",
      stream: true,
      call: (client: any, params: object) =>
        new app.Responses(client).create(params),
    },
    {
      channel: "responses.parse",
      stream: false,
      call: (client: any, params: object) =>
        new app.Responses(client).parse(params),
    },
    {
      channel: "chat.completions.create",
      stream: true,
      call: (client: any, params: object) =>
        new app.Completions(client).create(params),
    },
    {
      channel: "beta.chat.completions.parse",
      stream: false,
      call: (client: any, params: object) =>
        new app.BetaCompletions(client).parse(params),
    },
  ])(
    "$channel (stream: $stream) resolves to the provider value",
    async ({ channel, stream, call }) => {
      const events = recordChannel(`orchestrion:openai:${channel}`);
      const response = stream
        ? {
            async *[Symbol.asyncIterator]() {
              yield { delta: "Hello" };
            },
          }
        : { output: ["Hello world"] };

      const result = await call(
        { post: async () => response },
        { model: "gpt-4", stream },
      );

      expect(result).toBe(response);
      expect(eventTypes(events)).toEqual(PROMISE_LIFECYCLE);
      expect(events[0].context.result).toBe(response);
    },
  );

  it.each([
    {
      channel: "beta.chat.completions.stream",
      call: (client: any) =>
        new app.BetaCompletions(client).stream({ model: "gpt-4" }),
    },
    {
      channel: "responses.stream",
      call: (client: any) =>
        new app.Responses(client).stream({ model: "gpt-4" }),
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
    const events = recordChannel("orchestrion:custom-sdk:process");
    const bundled = await bundle(
      "esbuild",
      path.join(fixturesDir, "custom-sdk-app.mjs"),
      {
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
