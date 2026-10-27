import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { interceptorsByName, mockNewTracingChannel, mockStartSpan } = vi.hoisted(
  () => ({
    interceptorsByName: new Map<string, any>(),
    mockNewTracingChannel: vi.fn(),
    mockStartSpan: vi.fn(),
  }),
);

vi.mock("../../isomorph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../isomorph")>();
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    ...actual,
    default: {
      ...actual.default,
      getEnv: (name: string) => process.env[name],
      newAsyncLocalStorage: <T>() => new AsyncLocalStorage<T>(),
    },
  };
});

vi.mock("../../global-instrumentation-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../global-instrumentation-hooks")
  >()),
  newGlobalInvocationHook: mockNewTracingChannel,
}));

vi.mock("../../logger", async (importOriginal) => ({
  Attachment: (await importOriginal<typeof import("../../logger")>())
    .Attachment,
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
  withCurrent: (_span: unknown, callback: () => unknown) => callback(),
}));

import type {
  PiAssistantMessage,
  PiContext,
  PiModel,
  PiSimpleStreamOptions,
} from "../../vendor-sdk-types/pi-coding-agent";
import { PiCodingAgentPlugin } from "./pi-coding-agent-plugin";

const PROMPT_CHANNEL =
  "orchestrion:@earendil-works/pi-coding-agent:AgentSession.prompt";

type TestSpan = {
  args: any;
  end: ReturnType<typeof vi.fn>;
  export: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  name?: string;
};

describe("PiCodingAgentPlugin", () => {
  let plugins: PiCodingAgentPlugin[];
  let spans: TestSpan[];

  beforeEach(() => {
    plugins = [];
    spans = [];
    interceptorsByName.clear();
    mockNewTracingChannel.mockImplementation((name: string) => ({
      intercept(interceptor: unknown) {
        interceptorsByName.set(name, interceptor);
        return () => {
          interceptorsByName.delete(name);
        };
      },
      invoke(
        target: (...args: unknown[]) => unknown,
        receiver: unknown,
        args: unknown[],
        additional: object,
      ) {
        const interceptor = interceptorsByName.get(name);
        return interceptor
          ? interceptor(target, receiver, args, additional)
          : Reflect.apply(target, receiver, args);
      },
    }));
    mockStartSpan.mockImplementation((args: any) => {
      const span = {
        args,
        end: vi.fn(),
        export: vi.fn(async () => `${args.name}-export-${spans.length}`),
        log: vi.fn(),
        name: args.name,
      };
      if (args.event) {
        span.log(args.event);
      }
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    for (const plugin of plugins) {
      plugin.disable();
    }
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("preserves Pi 1.4 prompt deltas and resolves tool updates without mutation", async () => {
    const original = {
      name: "lookup",
      description: "Old lookup",
      parameters: { type: "object" },
    };
    const replacement = { ...original, description: "New lookup" };
    const prototypeNamed = { name: "__proto__", description: "Safe name" };
    const context: PiContext = {
      tools: [{ name: "stale" }],
      messages: [
        {
          role: "system",
          content: "Base instructions",
          sections: JSON.parse(
            '{"preamble":"Be helpful","cwd":"/old","__proto__":"Keep this section"}',
          ),
          toolsAdded: [original, { name: "removed" }, prototypeNamed],
        },
        { role: "user", content: "hello" },
        {
          role: "system",
          content: [
            { type: "text", text: "More instructions" },
            { type: "text", text: "Second block" },
          ],
          sections: { preamble: "Be concise", cwd: null, extra: "New section" },
          toolsRemoved: [{ name: "removed" }, { name: "lookup" }],
          toolsAdded: [replacement],
        },
        {
          role: "system",
          content: "",
          sections: { extra: null },
          toolsAdded: [{ ...prototypeNamed, description: "Updated safely" }],
        },
      ],
    };
    const originalContext = structuredClone(context);
    await captureContext(context);

    expect(
      findSpan(spans, "anthropic.messages.create")?.args.event.input,
    ).toEqual([
      {
        role: "system",
        content: "Base instructions\n\nBe helpful\n\n/old\n\nKeep this section",
      },
      { role: "user", content: "hello" },
      {
        role: "system",
        content:
          'More instructions\nSecond block\n\nUpdated system prompt section "preamble":\n\nBe concise\n\nRemoved system prompt section "cwd".\n\nUpdated system prompt section "extra":\n\nNew section',
      },
      {
        role: "system",
        content: 'Removed system prompt section "extra".',
      },
    ]);
    expect(
      findSpan(spans, "anthropic.messages.create")?.args.event.metadata.tools,
    ).toEqual([
      {
        type: "function",
        function: { ...prototypeNamed, description: "Updated safely" },
      },
      { type: "function", function: replacement },
    ]);
    expect(context).toEqual(originalContext);
  });

  it("does not restore legacy tools after the transcript removes every tool", async () => {
    await captureContext({
      tools: [{ name: "removed" }],
      messages: [
        { role: "system", content: "", toolsAdded: [{ name: "removed" }] },
        { role: "system", content: "", toolsRemoved: [{ name: "removed" }] },
      ],
    });

    expect(
      findSpan(spans, "anthropic.messages.create")?.args.event.metadata,
    ).not.toHaveProperty("tools");
  });

  it("falls back to legacy tools when system messages do not declare tools", async () => {
    await captureContext({
      tools: [{ name: "lookup" }],
      messages: [{ role: "system", content: "Instructions" }],
    });

    expect(
      findSpan(spans, "anthropic.messages.create")?.args.event.metadata.tools,
    ).toEqual([{ type: "function", function: { name: "lookup" } }]);
  });

  async function captureContext(context: PiContext) {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const originalStream = vi.fn(async (_model: PiModel, _context: PiContext) =>
      makeStream(makeAssistantMessage("done")),
    );
    const agent = makeAgent(originalStream, "streamFunction");
    const session = makeSession(agent);
    await interceptor(
      async () => {
        const stream = await agent.streamFunction(anthropicModel(), context);
        await stream.result();
      },
      session,
      ["hello", undefined],
      { moduleVersion: "1.4.0" },
    );
    expect(originalStream.mock.calls[0]?.[1]).toBe(context);
  }

  it("captures per-call usage and cost without double-counting parent rollups", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    // Pi input excludes cache usage; reasoning is already included in output.
    const usages: NonNullable<PiAssistantMessage["usage"]>[] = [
      {
        input: 5,
        output: 10,
        reasoning: 6,
        cacheRead: 20,
        cacheWrite: 8,
        cacheWrite1h: 3,
        cost: { total: 0.002 },
      },
      { input: 5, output: 3, cacheRead: 20, cacheWrite: 4, totalTokens: 32 },
    ];
    const expected: Record<string, number>[] = [
      {
        prompt_tokens: 33,
        completion_tokens: 10,
        tokens: 43,
        completion_reasoning_tokens: 6,
        prompt_cached_tokens: 20,
        prompt_cache_creation_tokens: 8,
        prompt_cache_creation_5m_tokens: 5,
        prompt_cache_creation_1h_tokens: 3,
        estimated_cost: 0.002,
      },
      {
        prompt_tokens: 29,
        completion_tokens: 3,
        tokens: 32,
        prompt_cached_tokens: 20,
        prompt_cache_creation_tokens: 4,
      },
    ];
    const originalStream = vi.fn();
    const agent = makeAgent(originalStream);
    await interceptor(
      async () => {
        for (const usage of usages) {
          const message = { ...makeAssistantMessage("done"), usage };
          originalStream.mockReturnValueOnce(makeStream(message));
          const stream = await agent.streamFn(anthropicModel(), {
            messages: [],
          });
          await stream.result();
          await agent.emit({ type: "turn_end", message, toolResults: [] });
        }
      },
      makeSession(agent),
      ["hello", undefined],
      {},
    );
    const llms = spans.filter(
      (span) => span.args.spanAttributes.type === "llm",
    );
    expect(llms).toHaveLength(usages.length);
    llms.forEach((span, index) =>
      expect(span.log.mock.calls.at(-1)?.[0].metrics).toEqual({
        ...expected[index],
        start: expect.any(Number),
        end: expect.any(Number),
      }),
    );
    for (const metric of Object.keys(expected[0])) {
      const total = spans.reduce(
        (sum, span) =>
          sum + (span.log.mock.calls.at(-1)?.[0].metrics?.[metric] ?? 0),
        0,
      );
      expect(total).toBe(
        expected.reduce((sum, usage) => sum + (usage[metric] ?? 0), 0),
      );
    }
  });

  async function captureMessage(
    message: PiAssistantMessage,
    options?: PiSimpleStreamOptions,
    model: PiModel = anthropicModel(),
  ) {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const agent = makeAgent(vi.fn(async () => makeStream(message)));
    await interceptor(
      async () => {
        const stream = await agent.streamFn(model, { messages: [] }, options);
        expect(await stream.result()).toBe(message);
        await agent.emit({ type: "message_end", message });
        await agent.emit({ type: "turn_end", message, toolResults: [] });
      },
      makeSession(agent),
      ["hello", undefined],
      {},
    );
    return spans.find((span) => span.args.spanAttributes.type === "llm")!;
  }

  it.each([
    {
      name: "missing usage",
      usage: { input: 2 },
      expected: { prompt_tokens: 2 },
    },
    {
      name: "invalid counts and cost",
      usage: {
        input: 2,
        output: 3.5,
        cacheRead: -1,
        reasoning: Infinity,
        totalTokens: NaN,
        cost: { total: Infinity },
      },
      expected: {},
    },
    {
      name: "reported totals, explicit zeros, and unpriced models",
      usage: {
        input: 2,
        output: 3,
        totalTokens: 9,
        reasoning: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        cost: { total: 0 },
      },
      expected: {
        prompt_tokens: 2,
        completion_tokens: 3,
        tokens: 9,
        completion_reasoning_tokens: 0,
        prompt_cache_creation_tokens: 0,
        prompt_cache_creation_1h_tokens: 0,
        prompt_cache_creation_5m_tokens: 0,
      },
    },
  ])("preserves metric completeness for $name", async ({ usage, expected }) => {
    const llm = await captureMessage({
      ...makeAssistantMessage("done"),
      usage,
    });
    expect(llm.log.mock.calls.at(-1)?.[0].metrics).toEqual({
      ...expected,
      start: expect.any(Number),
      end: expect.any(Number),
    });
  });

  it("attributes physical model dispatch while preserving the selected virtual model", async () => {
    const llm = await captureMessage(
      {
        ...makeAssistantMessage("done"),
        responseModel: "physical-model",
        thinkingLevel: "high",
        providerThinkingLevel: "medium",
      },
      undefined,
      { ...anthropicModel(), id: "virtual-model" },
    );
    expect(llm.log.mock.calls.at(-1)?.[0].metadata).toMatchObject({
      model: "physical-model",
      provider: "anthropic",
      selected_model: "anthropic/virtual-model",
      "pi_coding_agent.thinking_level": "high",
      "pi_coding_agent.provider_thinking_level": "medium",
    });
    expect(llm.name).toBe("anthropic.messages.create");
  });

  it("allowlists request controls without capturing arbitrary provider metadata", async () => {
    const options = {
      temperature: 0.2,
      maxTokens: 20,
      toolChoice: "none" as const,
      samplingParams: {
        top_p: 0.9,
        temperature: 0.1,
        tool_choice: "auto",
        parallel_tool_calls: false,
        presence_penalty: undefined,
        secret: "secret",
      },
      metadata: { user_id: "private-user" },
      apiKey: "secret",
      headers: { authorization: "secret" },
    };
    const before = structuredClone(options);
    const llm = await captureMessage(makeAssistantMessage("done"), options, {
      id: "model",
      provider: "openai",
      api: "openai-responses",
      samplingParams: {
        frequency_penalty: 0.5,
        top_p: 0.5,
        presence_penalty: 0.7,
        secret: "secret",
      },
    });
    const metadata = llm.args.event.metadata;
    expect(metadata).toMatchObject({
      temperature: 0.1,
      max_tokens: 20,
      top_p: 0.9,
      frequency_penalty: 0.5,
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(metadata).not.toHaveProperty("presence_penalty");
    expect(JSON.stringify(metadata)).not.toMatch(/secret|private-user/);
    expect(options).toEqual(before);
  });

  it("does not capture OpenAI-only sampling overrides for other providers", async () => {
    const llm = await captureMessage(makeAssistantMessage("done"), {
      temperature: 0.2,
      toolChoice: "none",
      samplingParams: { temperature: 0.1, top_p: 0.9 },
    });
    expect(llm.args.event.metadata).toMatchObject({
      temperature: 0.2,
      tool_choice: "none",
    });
    expect(llm.args.event.metadata).not.toHaveProperty("top_p");
  });

  it("omits unserializable sampling fields while retaining valid request metadata", async () => {
    const callback = vi.fn();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const llm = await captureMessage(
      makeAssistantMessage("done"),
      {
        samplingParams: {
          top_p: callback,
          stop: cycle,
          temperature: 0.2,
          frequency_penalty: Infinity,
        },
      },
      { ...anthropicModel(), api: "openai-responses" },
    );
    expect(llm.args.event.metadata.temperature).toBe(0.2);
    for (const field of ["top_p", "stop", "frequency_penalty"])
      expect(llm.args.event.metadata).not.toHaveProperty(field);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["success", "failure", "blocked"] as const)(
    "records tool approval only when the executor ran: %s",
    async (outcome) => {
      const interceptor = promptInterceptor(enablePlugin(plugins));
      const agent = makeAgent(
        vi.fn(() => makeStream(makeAssistantMessage("done"))),
      );
      const failure = new Error("tool failed");
      const tool = {
        name: "lookup",
        execute: vi.fn((_toolCallId: string) => {
          if (outcome === "failure") throw failure;
          return "result";
        }),
      };
      agent.state.tools = [tool];
      await interceptor(
        async () => {
          await agent.emit({
            type: "tool_execution_start",
            toolCallId: "call",
            toolName: "lookup",
            args: {},
          });
          if (outcome === "failure")
            expect(() => tool.execute("call")).toThrow(failure);
          if (outcome === "success")
            expect(tool.execute("call")).toBe("result");
          await agent.emit({
            type: "tool_execution_end",
            toolCallId: "call",
            toolName: "lookup",
            result:
              outcome === "blocked"
                ? "Tool execution was blocked"
                : outcome === "failure"
                  ? failure
                  : "result",
            isError: outcome !== "success",
          });
        },
        makeSession(agent),
        ["hello", undefined],
        {},
      );
      const log = findSpan(spans, "lookup")?.log.mock.calls.at(-1)?.[0];
      if (outcome === "blocked")
        expect(log.metadata).not.toHaveProperty("tool_approval");
      else expect(log.metadata.tool_approval).toBe("approved");
      if (outcome === "failure") expect(log.error).toBe(failure);
      if (outcome === "blocked") expect(log.error).toContain("blocked");
    },
  );

  it.each(["error", "aborted"])(
    "marks %s responses as failures without returning stale prompt output",
    async (stopReason) => {
      const message = {
        ...makeAssistantMessage("partial"),
        stopReason,
        errorMessage: "request failed",
      };
      const llm = await captureMessage(message);
      expect(llm.log.mock.calls.at(-1)?.[0]).toMatchObject({
        error: "request failed",
        output: expect.any(Array),
      });
      const task = findSpan(spans, "AgentSession.prompt");
      expect(task?.log.mock.calls.at(-1)?.[0]).toMatchObject({
        error: "request failed",
      });
      expect(task?.log.mock.calls.at(-1)?.[0].output).toBeUndefined();
    },
  );

  it.each(["text_delta", "thinking_delta", "toolcall_delta"])(
    "measures TTFT from the first nonempty %s",
    async (type) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const message = makeAssistantMessage("done");
      const events = [
        { type: "start", partial: message },
        { type: "text_start", partial: message },
        { type, delta: "", partial: message },
        { type, delta: "first", partial: message },
        { type, delta: "second", partial: message },
        { type: "done", message },
      ];
      const { stream } = makeIteratorBackedStream(events);
      const agent = makeAgent(vi.fn(async () => stream));
      const interceptor = promptInterceptor(enablePlugin(plugins));
      await interceptor(
        async () => {
          const observed = await agent.streamFn(anthropicModel(), {
            messages: [],
          });
          const iterator = observed[Symbol.asyncIterator]();
          for (let i = 0; i < events.length; i++) {
            vi.setSystemTime(2_000 + i * 1_000);
            expect((await iterator.next()).value).toBe(events[i]);
          }
        },
        makeSession(agent),
        ["hello", undefined],
        {},
      );
      expect(
        findSpan(spans, "anthropic.messages.create")?.log.mock.calls.at(-1)?.[0]
          .metrics.time_to_first_token,
      ).toBe(4);
    },
  );

  it.each(["steer", "followUp"] as const)(
    "does not trace queued %s prompts or correlate their later events",
    async (streamingBehavior) => {
      const interceptor = promptInterceptor(enablePlugin(plugins));
      const agent = makeAgent(
        vi.fn(() => makeStream(makeAssistantMessage("done"))),
      );
      const session = { ...makeSession(agent), isStreaming: true };
      let later: (() => Promise<void>) | undefined;
      const result = Promise.resolve();
      const returned = interceptor(
        () => {
          later = async () => {
            const stream = await agent.streamFn(anthropicModel(), {
              messages: [],
            });
            await stream.result();
            await agent.emit({
              type: "turn_end",
              message: makeAssistantMessage("queued"),
              toolResults: [],
            });
          };
          return result;
        },
        session,
        ["queued", { streamingBehavior }],
        {},
      );
      expect(returned).toBe(result);
      await returned;
      await later!();
      expect(spans).toHaveLength(0);
      expect(agent.subscribe).not.toHaveBeenCalled();
    },
  );

  it("finishes a direct idle prompt even when it specifies followUp behavior", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const agent = makeAgent(
      vi.fn(() => makeStream(makeAssistantMessage("done"))),
    );
    const session = { ...makeSession(agent), isStreaming: false };
    const result = Promise.resolve();
    expect(
      interceptor(
        () => result,
        session,
        ["direct", { streamingBehavior: "followUp" }],
        {},
      ),
    ).toBe(result);
    await result;
    expect(findSpan(spans, "AgentSession.prompt")?.end).toHaveBeenCalledTimes(
      1,
    );
  });

  it.each([false, true])(
    "preserves stream and promise identities with async=%s",
    async (asyncStream) => {
      const interceptor = promptInterceptor(enablePlugin(plugins));
      const stream = makeStream(makeAssistantMessage("done"));
      const completion = stream.result();
      stream.result = vi.fn(() => completion);
      class StreamPromise extends Promise<typeof stream> {
        helper() {
          return "kept";
        }
      }
      const streamResult = asyncStream
        ? new StreamPromise((resolve) => resolve(stream))
        : stream;
      const agent = makeAgent(vi.fn(() => streamResult));
      const session = makeSession(agent);
      let promptResult: Promise<void>;
      const returned = interceptor(
        () => {
          promptResult = (async () => {
            const observed = agent.streamFn(anthropicModel(), { messages: [] });
            expect(observed).toBe(streamResult);
            if (observed instanceof StreamPromise)
              expect(observed.helper()).toBe("kept");
            expect(await observed).toBe(stream);
            const result = stream.result();
            expect(result).toBe(completion);
            expect(await result).toMatchObject({ role: "assistant" });
          })();
          return promptResult;
        },
        session,
        ["hello", undefined],
        {},
      );
      expect(returned).toBe(promptResult!);
      await returned;
    },
  );

  it("does not let input extraction failures replace or retry the provider call", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const stream = makeStream(makeAssistantMessage("done"));
    const target = vi.fn(() => stream);
    const agent = makeAgent(target);
    await interceptor(
      async () => {
        const context = {
          get messages(): never {
            throw new Error("invalid context");
          },
        };
        expect(await agent.streamFn(anthropicModel(), context)).toBe(stream);
      },
      makeSession(agent),
      ["hello", undefined],
      {},
    );
    expect(target).toHaveBeenCalledTimes(1);
  });

  it.each(["false", "true"])(
    "applies attachment consent %s to prompt, conversation, and tool output",
    async (consent) => {
      vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", consent);
      const enabled = consent === "true" || consent === "1";
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
      const image = {
        type: "image" as const,
        mimeType: "image/png",
        data: png,
      };
      const context: PiContext = {
        messages: [
          { role: "user", content: [image] },
          {
            role: "toolResult",
            toolCallId: "previous",
            toolName: "image",
            content: [image],
          },
        ],
      };
      const before = structuredClone(context);
      const interceptor = promptInterceptor(enablePlugin(plugins));
      const message = makeAssistantMessage("done");
      const agent = makeAgent(vi.fn(() => makeStream(message)));
      const result = {
        content: [{ type: "text", text: "image result" }, image],
        details: { useful: true },
      };
      await interceptor(
        async () => {
          const stream = await agent.streamFn(anthropicModel(), context);
          await stream.result();
          await agent.emit({
            type: "tool_execution_start",
            toolCallId: "image",
            toolName: "image",
            args: {},
          });
          await agent.emit({
            type: "tool_execution_end",
            toolCallId: "image",
            toolName: "image",
            result,
            isError: true,
          });
        },
        makeSession(agent),
        ["describe", { images: [image] }],
        {},
      );
      const prompt = findSpan(spans, "AgentSession.prompt")!;
      const llm = findSpan(spans, "anthropic.messages.create")!;
      const tool = findSpan(spans, "image")!;
      const loggedImages = [
        prompt.args.event.input[0].content[1].image_url.url,
        llm.args.event.input[0].content[0].image_url.url,
        llm.args.event.input[1].content[0].image_url.url,
        tool.log.mock.calls.at(-1)?.[0].output.content[1].image_url.url,
      ];
      for (const logged of loggedImages) {
        if (enabled) expect(logged.constructor.name).toBe("Attachment");
        else expect(logged).toBe("<omitted>");
      }
      expect(
        JSON.stringify(spans.flatMap((span) => span.log.mock.calls)),
      ).not.toContain(png);
      expect(context).toEqual(before);
      expect(result.content[1]).toBe(image);
      for (const span of [prompt, llm]) {
        expect(span.log.mock.calls.at(-1)?.[0].metrics).not.toHaveProperty(
          "duration",
        );
      }
    },
  );

  it("does not read inline bytes when attachment capture is disabled", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "false");
    const data = vi.fn(() => {
      throw new Error("must not read bytes");
    });
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      get data(): string {
        return data();
      },
    };
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const agent = makeAgent(
      vi.fn(() => makeStream(makeAssistantMessage("done"))),
    );
    await interceptor(
      async () => {
        const stream = await agent.streamFn(anthropicModel(), {
          messages: [{ role: "user", content: [image] }],
        });
        await stream.result();
      },
      makeSession(agent),
      ["describe", { images: [image] }],
      {},
    );
    expect(data).not.toHaveBeenCalled();
    expect(findSpan(spans, "anthropic.messages.create")).toBeDefined();
  });

  it("preserves visible reasoning and tool-call correlation in subsequent context", async () => {
    const message: PiAssistantMessage = {
      ...makeAssistantMessage("answer"),
      content: [
        {
          type: "thinking",
          thinking: "reason",
          signature: "private-signature",
        },
        { type: "thinking", thinking: "hidden", redacted: true },
        { type: "text", text: "answer" },
        {
          type: "toolCall",
          id: "call-1",
          name: "lookup",
          arguments: { query: "x" },
        },
      ],
    };
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const agent = makeAgent(vi.fn(() => makeStream(message)));
    await interceptor(
      async () => {
        const stream = await agent.streamFn(anthropicModel(), {
          messages: [
            message,
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "lookup",
              content: [{ type: "text", text: "found" }],
            },
          ],
        });
        await stream.result();
      },
      makeSession(agent),
      ["hello", undefined],
      {},
    );
    const llm = findSpan(spans, "anthropic.messages.create")!;
    const expected = {
      role: "assistant",
      content: "answer",
      reasoning_content: "reason",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: '{"query":"x"}' },
        },
      ],
    };
    expect(llm.args.event.input).toEqual([
      expected,
      {
        role: "tool",
        tool_call_id: "call-1",
        content: [{ type: "text", text: "found" }],
      },
    ]);
    expect(llm.log.mock.calls.at(-1)?.[0].output[0].message).toEqual(expected);
    expect(JSON.stringify(llm.log.mock.calls)).not.toMatch(
      /private-signature|hidden/,
    );
  });

  it("preserves full-iterator stream behavior", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const message = makeAssistantMessage("done");
    const { result, stream } = makeIteratorBackedStream([
      { partial: message, type: "start" },
      { message, type: "done" },
    ]);
    const agent = makeAgent(vi.fn(async () => stream));
    const session = makeSession(agent);

    await interceptor(
      async function (this: typeof session) {
        const patchedStream = await this.agent.streamFn(anthropicModel(), {
          messages: [{ role: "user", content: "iterate" }],
        });
        for await (const _event of patchedStream) {
          // Consume through iteration without calling result().
        }
      },
      session,
      ["iterate", undefined],
      {},
    );

    const llmSpan = findSpan(spans, "anthropic.messages.create");
    expect(result).not.toHaveBeenCalled();
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({ tokens: 8 }),
        output: expect.any(Array),
      }),
    );
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
    expect(llmSpan?.log.mock.calls.at(-1)?.[0].metrics).not.toHaveProperty(
      "time_to_first_token",
    );
  });

  it("forwards iterator failures and closes the underlying iterator", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const { iterator, stream } = makeIteratorBackedStream([]);
    const error = new Error("stream next failed");
    iterator.next.mockRejectedValueOnce(error);
    const agent = makeAgent(vi.fn(async () => stream));
    const session = makeSession(agent);

    await expect(
      interceptor(
        async function (this: typeof session) {
          const patchedStream = await this.agent.streamFn(anthropicModel(), {
            messages: [{ role: "user", content: "failure" }],
          });
          await patchedStream[Symbol.asyncIterator]().next();
        },
        session,
        ["failure", undefined],
        {},
      ),
    ).rejects.toThrow("stream next failed");

    const llmSpan = findSpan(spans, "anthropic.messages.create");
    const taskSpan = findSpan(spans, "AgentSession.prompt");
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error }),
    );
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
    expect(taskSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error }),
    );
  });

  it("closes active prompt and LLM spans when the target rejects", async () => {
    const interceptor = promptInterceptor(enablePlugin(plugins));
    const agent = makeAgent(
      vi.fn(async () => makeStream(makeAssistantMessage("unused"))),
    );
    const session = makeSession(agent);
    const error = new Error("boom");

    await expect(
      interceptor(
        async function (this: typeof session) {
          await this.agent.streamFn(anthropicModel(), {
            messages: [{ role: "user", content: "hello" }],
          });
          throw error;
        },
        session,
        ["hello", undefined],
        {},
      ),
    ).rejects.toThrow("boom");

    const llmSpan = findSpan(spans, "anthropic.messages.create");
    const taskSpan = findSpan(spans, "AgentSession.prompt");
    expect(llmSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error }),
    );
    expect(llmSpan?.end).toHaveBeenCalledTimes(1);
    expect(taskSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error }),
    );
    expect(taskSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("ends in-flight prompts on disable while leaving the safe patch installed", async () => {
    const plugin = enablePlugin(plugins);
    const interceptor = promptInterceptor(plugin);
    const originalStreamFn = vi.fn(async () =>
      makeStream(makeAssistantMessage("done")),
    );
    const agent = makeAgent(originalStreamFn);
    const session = makeSession(agent);
    const targetGate = deferred<void>();

    const result = interceptor(
      async () => {
        await targetGate.promise;
      },
      session,
      ["disable", undefined],
      {},
    );
    const patchedStreamFn = agent.streamFn;

    plugin.disable();

    const taskSpan = findSpan(spans, "AgentSession.prompt");
    expect(agent.streamFn).toBe(patchedStreamFn);
    expect(agent.streamFn).not.toBe(originalStreamFn);
    expect(taskSpan?.end).toHaveBeenCalledTimes(1);

    targetGate.resolve();
    await result;
    expect(taskSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("keeps installed tool wrappers working across SDK copies", async () => {
    const first = enablePlugin(plugins);
    const tool = { name: "lookup", execute: vi.fn((_id: string) => "result") };
    const agent = makeAgent(
      vi.fn(() => makeStream(makeAssistantMessage("done"))),
    );
    agent.state.tools = [tool];
    const session = makeSession(agent);
    await promptInterceptor(first)(
      async () => {},
      session,
      ["first", undefined],
      {},
    );
    const installedWrapper = tool.execute;
    first.disable();

    vi.resetModules();
    const { PiCodingAgentPlugin: OtherCopy } =
      await import("./pi-coding-agent-plugin");
    const second = new OtherCopy();
    plugins.push(second);
    second.enable();
    await promptInterceptor(second)(
      async () => {
        await agent.emit({
          type: "tool_execution_start",
          toolCallId: "call",
          toolName: "lookup",
          args: {},
        });
        expect(tool.execute("call")).toBe("result");
        await agent.emit({
          type: "tool_execution_end",
          toolCallId: "call",
          toolName: "lookup",
          result: "result",
          isError: false,
        });
      },
      session,
      ["second", undefined],
      {},
    );
    expect(tool.execute).toBe(installedWrapper);
    expect(
      findSpan(spans, "lookup")?.log.mock.calls.at(-1)?.[0].metadata
        .tool_approval,
    ).toBe("approved");
  });
});

function enablePlugin(plugins: PiCodingAgentPlugin[]): PiCodingAgentPlugin {
  const plugin = new PiCodingAgentPlugin();
  plugins.push(plugin);
  plugin.enable();
  return plugin;
}

function promptInterceptor(_plugin: PiCodingAgentPlugin): any {
  const interceptor = interceptorsByName.get(PROMPT_CHANNEL);
  expect(interceptor).toEqual(expect.any(Function));
  return interceptor;
}

function findSpan(spans: TestSpan[], name: string): TestSpan | undefined {
  return spans.find((span) => span.name === name);
}

function anthropicModel() {
  return {
    api: "anthropic-messages",
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
  };
}

function makeAssistantMessage(text: string): PiAssistantMessage {
  return {
    api: "anthropic-messages",
    content: [{ type: "text", text }],
    model: "claude-haiku-4-5",
    provider: "anthropic",
    role: "assistant",
    stopReason: "stop",
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 5,
      output: 3,
      totalTokens: 8,
    },
  };
}

function makeStream(message: PiAssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { partial: message, type: "start" };
      yield { message, type: "done" };
    },
    result: vi.fn(async () => message),
  };
}

function makeIteratorBackedStream(events: any[]) {
  const pendingEvents = [...events];
  const result = vi.fn(async () => makeAssistantMessage("done"));
  const iterator: any = {
    next: vi.fn(async () => {
      const event = pendingEvents.shift();
      return event
        ? { done: false, value: event }
        : { done: true, value: undefined };
    }),
    return: vi.fn(async (value?: unknown) => ({ done: true, value })),
    throw: vi.fn(async (error?: unknown) => {
      throw error;
    }),
  };
  return {
    iterator,
    result,
    stream: {
      [Symbol.asyncIterator]: vi.fn(() => iterator),
      result,
    },
  };
}

function makeAgent(
  streamFunction: any,
  property: "streamFn" | "streamFunction" = "streamFn",
): any {
  const listeners = new Set<any>();
  return {
    state: { model: anthropicModel(), tools: [] as any[] },
    [property]: streamFunction,
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return vi.fn(() => listeners.delete(listener));
    }),
    async emit(event: any) {
      for (const listener of [...listeners]) {
        await listener(event, new AbortController().signal);
      }
    },
  };
}

function makeSession(agent: ReturnType<typeof makeAgent>) {
  return {
    agent,
    subscribe: agent.subscribe.bind(agent),
    getActiveToolNames: () => ["bash"],
    model: anthropicModel(),
    prompt: vi.fn(),
    sessionId: "session-1",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
