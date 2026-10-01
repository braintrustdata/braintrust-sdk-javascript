import type { LoggingEvent } from "../../../util";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger";
import { configureNode } from "../../node/config";
import { wrapLiveKitAgents } from "../../wrappers/livekit-agents";
import { liveKitAgentsChannels as channels } from "./livekit-agents-channels";
import { registry } from "../registry";
import type { LiveKitNodeArgs } from "../../vendor-sdk-types/livekit-agents";

configureNode();
let background: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
const originalCapture = process.env.BRAINTRUST_CAPTURE_ATTACHMENTS;
beforeAll(async () => _exportsForTestingOnly.simulateLoginForTests());
beforeEach(() => {
  delete process.env.BRAINTRUST_CAPTURE_ATTACHMENTS;
  background = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({
    projectName: "tmp-luca-livekit-unit",
    projectId: "test-project-id",
  });
});
afterEach(() => {
  if (originalCapture === undefined)
    delete process.env.BRAINTRUST_CAPTURE_ATTACHMENTS;
  else process.env.BRAINTRUST_CAPTURE_ATTACHMENTS = originalCapture;
  registry.enable();
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

function fixture() {
  class Agent {
    static default = {
      async llmNode(_agent: Agent, ..._args: LiveKitNodeArgs) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue({ delta: {} });
            controller.enqueue({ delta: { content: "hello" } });
            controller.enqueue({
              usage: {
                promptTokens: 3,
                completionTokens: 1,
                totalTokens: 4,
                promptCachedTokens: 2,
              },
            });
            controller.close();
          },
        });
      },
      async sttNode(_agent: Agent, ..._args: LiveKitNodeArgs) {
        return null;
      },
      async ttsNode(_agent: Agent, ..._args: LiveKitNodeArgs) {
        return null;
      },
    };
    getActivityOrThrow() {
      return {
        llm: { model: "test-model", provider: "test-provider" },
        stt: { model: "stt", provider: "test-provider" },
        tts: { model: "tts", provider: "test-provider" },
      };
    }
    llmNode(...args: LiveKitNodeArgs) {
      return Agent.default.llmNode(this, ...args);
    }
    sttNode(...args: LiveKitNodeArgs) {
      return Agent.default.sttNode(this, ...args);
    }
    ttsNode(...args: LiveKitNodeArgs) {
      return Agent.default.ttsNode(this, ...args);
    }
  }
  // Native ESM namespace objects have a null prototype.
  return Object.assign(Object.create(null), {
    voice: Object.assign(Object.create(null), { Agent }),
    llm: Object.assign(Object.create(null), { tool: <T>(tool: T) => tool }),
  }) as { voice: { Agent: typeof Agent }; llm: { tool: <T>(tool: T) => T } };
}

it("deduplicates delegated nodes, preserves stream identity, and captures usage under the caller parent", async () => {
  const sdk = fixture();
  expect(wrapLiveKitAgents(wrapLiveKitAgents(sdk))).toBe(
    wrapLiveKitAgents(sdk),
  );
  const agent = new sdk.voice.Agent();
  const parent = startSpan({ name: "session" });
  await withCurrent(parent, async () => {
    const result = await agent.llmNode(
      { items: [{ type: "message", role: "user", content: ["hi"] }] },
      { functionTools: {} },
    );
    const chunks = [];
    const reader = result!.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(chunks).toHaveLength(3);
  });
  parent.end();
  const rows = (await background.drain()) as LoggingEvent[];
  const llms = rows.filter(
    (row) => row.span_attributes?.name === "livekit.Agent.llmNode",
  );
  expect(llms).toHaveLength(1);
  expect(llms[0].span_parents).toEqual([parent.spanId]);
  expect(llms[0].metrics).toMatchObject({
    tokens: 4,
    prompt_cached_tokens: 2,
    time_to_first_token: expect.any(Number),
  });
  expect(llms[0].output).toEqual([
    { message: { role: "assistant", content: "hello" } },
  ]);
});

it.each([false, true])(
  "captures speech bytes only with attachment opt-in (%s)",
  async (capture) => {
    if (capture) process.env.BRAINTRUST_CAPTURE_ATTACHMENTS = "true";
    const agent = new (fixture().voice.Agent)();
    let byteReads = 0;
    const frame = {
      sampleRate: 16000,
      channels: 1,
      samplesPerChannel: 2,
      get data() {
        byteReads++;
        return new Int16Array([100, -100]);
      },
    };
    const input = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("hello");
        controller.close();
      },
    });
    const stream = new ReadableStream({
      async start(controller) {
        // Defer consumption until the instrumentation is attached to the input.
        await Promise.resolve();
        for await (const _ of input as unknown as AsyncIterable<string>) {
          /* consume */
        }
        controller.enqueue(frame);
        controller.close();
      },
    });
    const promise = Promise.resolve(stream);
    expect(channels.ttsNode.invoke(() => promise, agent, [input], {})).toBe(
      promise,
    );
    const result = await promise;
    expect(result).toBe(stream);
    await result.pipeTo(new WritableStream());
    expect(byteReads > 0).toBe(capture);
    const rows = (await background.drain()) as LoggingEvent[];
    expect(rows[0].input).toEqual({ operation: "speech", prompt: "hello" });
    expect(rows[0].output).toEqual({
      content: capture
        ? [
            expect.objectContaining({
              type: "file",
              file: expect.objectContaining({
                filename: "audio-1.wav",
                file_data: expect.objectContaining({
                  reference: expect.objectContaining({
                    type: "braintrust_attachment",
                    content_type: "audio/wav",
                  }),
                }),
              }),
            }),
          ]
        : [],
    });
  },
);

it("records only final transcripts and ignores control events for first-content timing", async () => {
  const agent = new (fixture().voice.Agent)();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 0 });
      controller.enqueue({ type: 1, alternatives: [{ text: "hel" }] });
      controller.enqueue({
        type: 2,
        alternatives: [
          { text: "hello", language: "en", startTime: 0, endTime: 0.3 },
        ],
      });
      controller.enqueue({ type: 3, alternatives: [{ text: "hello" }] });
      controller.close();
    },
  });
  await channels.sttNode.invoke(
    async () => stream,
    agent,
    [new ReadableStream()],
    {},
  );
  for await (const _ of stream as unknown as AsyncIterable<unknown>) {
    /* consume */
  }
  const rows = (await background.drain()) as LoggingEvent[];
  expect(rows[0].output).toMatchObject({
    content: [{ type: "text", text: "hello" }],
    annotations: { language: "en" },
  });
  expect(rows[0].metrics).not.toHaveProperty("tokens");
});

it("preserves tool receiver, promise identity, errors, and disables installed patches", async () => {
  const sdk = wrapLiveKitAgents(fixture());
  const failure = new Error("tool failed");
  const tool = sdk.llm.tool({
    name: "lookup",
    execute() {
      expect(this).toBe(tool);
      return Promise.reject(failure);
    },
  });
  await expect(tool.execute()).rejects.toBe(failure);
  let rows = (await background.drain()) as LoggingEvent[];
  expect(rows[0].span_attributes).toMatchObject({
    name: "lookup",
    type: "tool",
  });
  expect(rows[0].error).toContain("tool failed");
  registry.disable();
  await expect(tool.execute()).rejects.toBe(failure);
  rows = (await background.drain()) as LoggingEvent[];
  expect(rows).toEqual([]);
});

it("keeps concurrent streams on their own parents and ends cancelled/error spans once", async () => {
  const agent = new (fixture().voice.Agent)();
  await Promise.all(
    ["one", "two"].map(async (name) => {
      const parent = startSpan({ name });
      await withCurrent(parent, async () => {
        let count = 0;
        const stream = new ReadableStream(
          {
            pull(controller) {
              if (count++ === 0)
                controller.enqueue({ delta: { content: name } });
              else controller.error(new Error(name));
            },
          },
          { highWaterMark: 0 },
        );
        await channels.llmNode.invoke(
          async () => stream,
          agent,
          [{ items: [] }, { functionTools: {} }],
          {},
        );
        const reader = stream.getReader();
        await reader.read();
        if (name === "one") await reader.cancel();
        else await expect(reader.read()).rejects.toThrow(name);
      });
      parent.end();
    }),
  );
  const rows = (await background.drain()) as LoggingEvent[];
  for (const name of ["one", "two"]) {
    const parent = rows.find((row) => row.span_attributes?.name === name)!;
    const children = rows.filter((row) =>
      row.span_parents?.includes(parent.span_id!),
    );
    expect(children).toHaveLength(1);
    expect(children[0].output).toEqual([
      { message: { role: "assistant", content: name } },
    ]);
    expect(children[0].metrics?.end).toBeDefined();
    if (name === "two") expect(children[0].error).toContain(name);
  }
});

it("observes custom nodes that delegate to Agent.default without tracing unrelated overrides", async () => {
  const sdk = wrapLiveKitAgents(fixture());
  class CustomAgent extends sdk.voice.Agent {
    override llmNode(
      ...args: LiveKitNodeArgs
    ): Promise<ReadableStream<unknown>> {
      return sdk.voice.Agent.default.llmNode(this, ...args);
    }
    override ttsNode() {
      return Promise.resolve(null);
    }
  }
  const agent = new CustomAgent();
  const stream = await agent.llmNode({ items: [] }, { functionTools: {} });
  await stream.pipeTo(new WritableStream());
  expect(await agent.ttsNode()).toBeNull();
  const rows = (await background.drain()) as LoggingEvent[];
  expect(rows).toHaveLength(1);
  expect(rows[0].span_attributes?.name).toBe("livekit.Agent.llmNode");
  expect(rows[0].metrics?.end).toBeDefined();
});

it("preserves rejected node promises and null node results", async () => {
  const agent = new (fixture().voice.Agent)();
  const failure = new Error("cannot start node");
  const promise = Promise.reject(failure);
  const result = channels.llmNode.invoke(
    () => promise,
    agent,
    [{ items: [] }, { functionTools: {} }],
    {},
  );
  expect(result).toBe(promise);
  await expect(result).rejects.toBe(failure);
  expect(
    await channels.ttsNode.invoke(
      async () => null,
      agent,
      [new ReadableStream()],
      {},
    ),
  ).toBeNull();
  const rows = (await background.drain()) as LoggingEvent[];
  expect(rows).toHaveLength(2);
  expect(rows[0].error).toContain("cannot start node");
  for (const row of rows) {
    expect(row.metrics?.end).toBeDefined();
    expect(row.metrics).not.toHaveProperty("time_to_first_token");
  }
});

it("preserves synchronous tool results and failures and the original tool promise", async () => {
  const sdk = wrapLiveKitAgents(fixture());
  const value = { answer: 42 };
  const sync = sdk.llm.tool({ name: "sync", execute: () => value });
  expect(sync.execute()).toBe(value);
  const promise = Promise.resolve(value);
  const async = sdk.llm.tool({ name: "async", execute: () => promise });
  expect(async.execute()).toBe(promise);
  await promise;
  const failure = new Error("sync tool failure");
  const throwing = sdk.llm.tool({
    name: "throwing",
    execute() {
      throw failure;
    },
  });
  expect(() => throwing.execute()).toThrow(failure);
  const rows = (await background.drain()) as LoggingEvent[];
  expect(rows).toHaveLength(3);
  expect(
    rows.find((row) => row.span_attributes?.name === "throwing")?.error,
  ).toContain("sync tool failure");
});
