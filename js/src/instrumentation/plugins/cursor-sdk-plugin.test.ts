import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newGlobalInvocationHook } from "../../global-instrumentation-hooks";
import { invocationController } from "../test-utils/invocation";

vi.mock("../../global-instrumentation-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../global-instrumentation-hooks")
  >()),
  newGlobalInvocationHook: vi.fn(),
}));
const { mockStartSpan } = vi.hoisted(() => ({ mockStartSpan: vi.fn() }));
vi.mock("../../isomorph", () => ({
  default: { newAsyncLocalStorage: <T>() => new AsyncLocalStorage<T>() },
}));
vi.mock("../../logger", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
  withCurrent: (_span: unknown, call: () => unknown) => call(),
}));
import { CursorSDKPlugin } from "./cursor-sdk-plugin";

describe("CursorSDKPlugin", () => {
  let handlers: Map<string, ReturnType<typeof invocationController>>;
  let spans: any[];
  let plugin: CursorSDKPlugin;
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const handler = (name: string) =>
    handlers.get(`orchestrion:@cursor/sdk:${name}`)!;
  const root = () => spans.find((s) => s.name === "Cursor Agent");
  const finalLog = () => root().log.mock.calls.at(-1)[0];
  function send(run: any, options?: any) {
    let observedOptions: any;
    const result = handler("agent.send").call(
      { arguments: ["hello", options] },
      (_message?: any, opts?: any) => {
        observedOptions = opts;
        return Promise.resolve(run);
      },
    );
    return { result, options: observedOptions };
  }
  beforeEach(() => {
    spans = [];
    handlers = new Map();
    vi.mocked(newGlobalInvocationHook).mockImplementation(
      (name: string) =>
        ({
          intercept: vi.fn((interceptor) => {
            handlers.set(name, invocationController(interceptor));
            return vi.fn();
          }),
          invoke: vi.fn((fn, receiver, args) =>
            Reflect.apply(fn, receiver, args),
          ),
        }) as any,
    );
    mockStartSpan.mockImplementation((args: any) => {
      const id = `span-${spans.length}`;
      const span = {
        ...args,
        id,
        end: vi.fn(),
        export: vi.fn(async () => id),
        log: vi.fn(),
      };
      if (args.event) span.log(args.event);
      spans.push(span);
      return span;
    });
    plugin = new CursorSDKPlugin();
    plugin.enable();
  });
  afterEach(() => {
    plugin.disable();
    vi.clearAllMocks();
  });

  it("patches factory agents once without replacing their promises", async () => {
    const agent = { send: vi.fn(async (_message?: string) => makeRun()) };
    const originalSend = agent.send;
    let patchedSend: typeof agent.send | undefined;
    for (const [name, args] of [
      ["Agent.create", [{}]],
      ["Agent.resume", ["agent-1"]],
    ] as const) {
      const promise = Promise.resolve(agent);
      expect(
        handler(name).call(
          { arguments: [...args], moduleVersion: "1.0.12" },
          () => promise,
        ),
      ).toBe(promise);
      await promise;
      expect(agent.send).not.toBe(originalSend);
      if (patchedSend) expect(agent.send).toBe(patchedSend);
      patchedSend = agent.send;
    }
    await agent.send("hi");
    expect(originalSend).toHaveBeenCalledExactlyOnceWith("hi");
    expect(spans).toHaveLength(0);
  });

  it("captures cache-inclusive usage without adding cache buckets twice", async () => {
    const { result, options } = send(makeRun());
    await result;
    options.onDelta({ update: { type: "token-delta", tokens: 500 } });
    options.onDelta({
      update: {
        type: "turn-ended",
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
        },
      },
    });
    options.onDelta({
      update: {
        type: "turn-ended",
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 1,
        },
      },
    });
    await ((await result) as any).wait();
    await settled();
    expect(finalLog().metrics).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 6,
      tokens: 18,
      prompt_cached_tokens: 1,
      prompt_cache_creation_tokens: 3,
    });
    expect(finalLog().metrics).not.toHaveProperty("cursor_sdk.delta_tokens");
    expect(root().end).toHaveBeenCalledOnce();
  });

  it("does not fabricate missing totals or accept invalid token counts", async () => {
    const { result, options } = send(makeRun());
    const run = (await result) as any;
    options.onDelta({
      update: {
        type: "turn-ended",
        usage: { inputTokens: -1, outputTokens: 2.5, cacheReadTokens: NaN },
      },
    });
    options.onDelta({
      update: { type: "turn-ended", usage: { outputTokens: 3 } },
    });
    await run.wait();
    await settled();
    expect(finalLog().metrics).not.toHaveProperty("tokens");
    expect(finalLog().metrics).not.toHaveProperty("prompt_tokens");
    expect(finalLog().metrics.completion_tokens).toBe(3);
  });

  it("updates tools, deduplicates event surfaces, and captures errors and truncation", async () => {
    const error = new Error("tool failed");
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "call-1", name: "shell", input: {} },
          ],
        },
      },
      {
        type: "tool_call",
        call_id: "call-1",
        name: "shell",
        status: "running",
        args: { command: "pwd" },
      },
      {
        type: "tool_call",
        call_id: "call-1",
        name: "shell",
        status: "error",
        result: error,
        truncated: { args: false, result: true },
      },
      { type: "request", request_id: "req-1" },
    ];
    const run = makeRun(messages);
    const { result, options } = send(run);
    await result;
    options.onDelta({
      update: {
        type: "tool-call-started",
        callId: "call-1",
        toolCall: { type: "shell", args: {} },
      },
    });
    options.onDelta({
      update: {
        type: "tool-call-completed",
        callId: "call-1",
        toolCall: { type: "shell", result: error, status: "error" },
      },
    });
    const stream = run.stream();
    expect(stream).toBe(run.originalStream);
    const chunks = [];
    for await (const message of stream) chunks.push(message);
    await run.wait();
    await settled();
    const tools = spans.filter((s) => s.name === "shell");
    expect(tools).toHaveLength(1);
    expect(tools[0].log).toHaveBeenCalledWith(
      expect.objectContaining({ input: { command: "pwd" } }),
    );
    expect(tools[0].log).toHaveBeenCalledWith(
      expect.objectContaining({
        error,
        output: error,
        metadata: {
          "cursor_sdk.tool.status": "error",
          "cursor_sdk.tool.args_truncated": false,
          "cursor_sdk.tool.result_truncated": true,
        },
      }),
    );
    expect(tools[0].end).toHaveBeenCalledOnce();
    expect(finalLog().metadata.request_id).toBe("req-1");
    expect(chunks).toEqual(messages);
  });

  it("records nested normalized and protobuf JSON tools under the subagent", async () => {
    const toolCall = {
      type: "task",
      args: { description: "dynamic description" },
      result: {
        status: "success",
        value: {
          conversationSteps: [
            {
              type: "toolCall",
              message: {
                type: "read",
                args: { path: "a" },
                result: { status: "error", error: { message: "missing" } },
              },
            },
            {
              toolCall: {
                shellToolCall: {
                  args: { command: "pwd" },
                  result: { success: { stdout: "ok" } },
                },
              },
            },
          ],
        },
      },
    };
    const { result, options } = send(makeRun());
    const run = (await result) as any;
    options.onDelta({
      update: { type: "tool-call-completed", callId: "task-1", toolCall },
    });
    options.onDelta({
      update: { type: "tool-call-completed", callId: "task-1", toolCall },
    });
    await run.wait();
    await settled();
    expect(spans.map((s) => s.name)).toEqual([
      "Cursor Agent",
      "task",
      "Cursor Subagent",
      "read",
      "shell",
    ]);
    const subagent = spans.find((s) => s.name === "Cursor Subagent");
    expect(spans.find((s) => s.name === "read").parent).toBe(subagent.id);
    expect(spans.find((s) => s.name === "shell").parent).toBe(subagent.id);
    expect(spans.find((s) => s.name === "read").log).toHaveBeenCalledWith(
      expect.objectContaining({ error: { message: "missing" } }),
    );
    for (const span of spans) expect(span.end).toHaveBeenCalledOnce();
  });

  it("preserves callback receivers, synchronous return values, and thrown errors", async () => {
    const error = new Error("callback failure");
    const callback = vi.fn(function (this: unknown) {
      expect(this).toBe(receiver);
      return 42;
    });
    const { result, options } = send(makeRun(), {
      onDelta: callback,
      onStep() {
        throw error;
      },
    });
    const receiver = {};
    expect(
      options.onDelta.call(receiver, {
        update: { type: "text-delta", text: "hi" },
      }),
    ).toBe(42);
    expect(() => options.onStep({ step: {} })).toThrow(error);
    const run = (await result) as any;
    await run.wait();
    await settled();
  });

  it.each(["throw", "reject"])(
    "preserves promises and error identity when wait fails via %s",
    async (failure) => {
      const error = new Error("wait failure");
      const waitPromise =
        failure === "reject"
          ? Object.assign(Promise.reject(error), { helper: () => "ok" })
          : undefined;
      const run = {
        ...makeRun(),
        wait() {
          if (waitPromise) return waitPromise;
          throw error;
        },
      };
      const sendPromise = Object.assign(Promise.resolve(run), {
        helper: () => "send",
      });
      const returned = handler("agent.send").call(
        { arguments: ["hi"] },
        () => sendPromise,
      );
      expect(returned).toBe(sendPromise);
      await returned;
      if (waitPromise) {
        expect(run.wait()).toBe(waitPromise);
        await expect(waitPromise).rejects.toBe(error);
      } else {
        expect(() => run.wait()).toThrow(error);
      }
      await settled();
      expect(finalLog().error).toBe(error);
      expect(root().end).toHaveBeenCalledOnce();
    },
  );

  it.each(["stream", "cancel"])(
    "ends open tools on %s cancellation",
    async (operation) => {
      const run = makeRun([
        {
          type: "tool_call",
          call_id: "open",
          name: "shell",
          status: "running",
        },
      ]);
      const { result } = send(run);
      await result;
      const stream = run.stream();
      await stream.next();
      if (operation === "stream") await stream.return();
      else await run.cancel();
      await settled();
      expect(finalLog().metadata["cursor_sdk.status"]).toBe("cancelled");
      for (const span of spans) expect(span.end).toHaveBeenCalledOnce();
    },
  );

  it("keeps concurrent prompt/send traces independent and captures nested prompt tools", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = handler("Agent.prompt").call(
      { arguments: ["prompt", {}] },
      async () => {
        await gate;
        const run = makeRun([
          {
            type: "tool_call",
            call_id: "nested",
            name: "shell",
            status: "completed",
            result: "ok",
          },
        ]);
        await handler("agent.send").call({ arguments: ["prompt"] }, () =>
          Promise.resolve(run),
        );
        for await (const _ of run.stream()) {
          /* consume */
        }
        return run.wait();
      },
    );
    const independent = send(makeRun());
    await independent.result;
    await ((await independent.result) as any).wait();
    release();
    await pending;
    await settled();
    expect(spans.filter((s) => s.name === "Cursor Agent")).toHaveLength(2);
    expect(spans.find((s) => s.name === "shell").parent).toBe(spans[0].id);
    for (const span of spans) expect(span.end).toHaveBeenCalledOnce();
  });
});

function makeRun(messages: unknown[] = []) {
  const stream = (async function* () {
    for (const message of messages) yield message;
  })();
  return {
    agentId: "agent-1",
    id: "run-1",
    result: "done",
    status: "finished",
    originalStream: stream,
    stream: () => stream,
    async wait() {
      return { id: "run-1", result: "done", status: "finished" };
    },
    async conversation() {
      return [];
    },
    async cancel() {},
  };
}
