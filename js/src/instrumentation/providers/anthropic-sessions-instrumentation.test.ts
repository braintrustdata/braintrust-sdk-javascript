import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStartSpan, mockWithCurrent } = vi.hoisted(() => ({
  mockStartSpan: vi.fn(),
  mockWithCurrent: vi.fn(),
}));

vi.mock("../../isomorph", () => ({
  default: {
    getEnv: vi.fn(),
    newAsyncLocalStorage: vi.fn(() => ({
      enterWith: vi.fn(),
      getStore: vi.fn(() => undefined),
      run: vi.fn((_store: unknown, callback: () => unknown) => callback()),
    })),
    newTracingChannel: vi.fn(),
  },
}));

vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    startSpan: (...args: unknown[]) => mockStartSpan(...args),
    withCurrent: (...args: unknown[]) => mockWithCurrent(...args),
  };
});

import iso from "../../isomorph";
import { collectAnthropicSession } from "../../wrappers/anthropic-session-collector";
import { registerAnthropicInstrumentation } from "./anthropic-instrumentation";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("registerAnthropicInstrumentation Sessions instrumentation", () => {
  let currentSpan: TestSpan | undefined;
  let handlersByName: Map<string, any>;
  let spans: TestSpan[];

  beforeEach(() => {
    currentSpan = undefined;
    handlersByName = new Map();
    spans = [];
    mockNewTracingChannel.mockImplementation((name: string) => ({
      subscribe: vi.fn((handlers) => handlersByName.set(name, handlers)),
    }));
    mockWithCurrent.mockImplementation(
      (span: TestSpan, callback: () => unknown) => {
        const previous = currentSpan;
        currentSpan = span;
        try {
          return callback();
        } finally {
          currentSpan = previous;
        }
      },
    );
    mockStartSpan.mockImplementation((args: any) => {
      const end = vi.fn<() => void>();
      const log = vi.fn<(event: unknown) => void>();
      const span: TestSpan = {
        args,
        end,
        log,
        parent: currentSpan,
      };
      if (args.event) {
        log(args.event);
      }
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records a session turn with model and tool children", async () => {
    registerAnthropicInstrumentation();
    const handlers = handlersByName.get(
      "orchestrion:@anthropic-ai/sdk:beta.sessions.events.stream",
    );
    const stream = sessionStream([
      {
        id: "user-1",
        type: "user.message",
        content: [{ type: "text", text: "Check the weather" }],
      },
      { id: "running-1", type: "session.status_running" },
      {
        id: "child-thread-idle",
        type: "session.thread_status_idle",
        stop_reason: { type: "end_turn" },
      },
      { id: "model-start-1", type: "span.model_request_start" },
      {
        id: "tool-1",
        type: "agent.tool_use",
        name: "get_weather",
        input: { city: "Paris" },
        evaluated_permission: "allow",
      },
      {
        id: "model-end-1",
        type: "span.model_request_end",
        model_request_start_id: "model-start-1",
        model_usage: usage(10, 3, 2, 1),
        is_error: false,
      },
      {
        id: "tool-result-1",
        type: "agent.tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: "18C" }],
        is_error: false,
      },
      { id: "model-start-2", type: "span.model_request_start" },
      {
        type: "event_delta",
        event_id: "message-1",
        delta: {
          type: "content_delta",
          index: 0,
          content: { type: "text", text: "It is" },
        },
      },
      {
        id: "message-1",
        type: "agent.message",
        content: [{ type: "text", text: "It is 18C" }],
      },
      {
        id: "model-end-2",
        type: "span.model_request_end",
        model_request_start_id: "model-start-2",
        model_usage: usage(20, 4),
        is_error: false,
      },
      {
        id: "idle-action",
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      },
      {
        id: "idle-end",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    ]);
    const context: {
      arguments: string[];
      result?: ReturnType<typeof sessionStream>;
    } = { arguments: ["session-1"] };

    handlers.start(context);
    handlers.asyncEnd(Object.assign(context, { result: stream }));
    expect(context.result).toBe(stream);
    expect(spans).toEqual([]);
    expect(collectAnthropicSession(stream)).toBe(stream);
    for await (const _event of stream) {
      // Consume the real stream exactly as user code would.
    }

    expect(
      spans.map((span) => [span.args.name, span.args.spanAttributes.type]),
    ).toEqual([
      ["anthropic.beta.sessions.turn", "task"],
      ["anthropic.messages.create", "llm"],
      ["get_weather", "tool"],
      ["anthropic.messages.create", "llm"],
    ]);

    const [turn, firstModel, tool, secondModel] = spans;
    expect(firstModel.parent).toBe(turn);
    expect(tool.parent).toBe(turn);
    expect(secondModel.parent).toBe(turn);
    expect(lastLog(firstModel)).toMatchObject({
      metrics: {
        completion_tokens: 3,
        prompt_cache_creation_tokens: 1,
        prompt_cached_tokens: 2,
        prompt_tokens: 13,
        tokens: 16,
      },
      output: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
      },
    });
    expect(lastLog(tool)).toEqual({
      metadata: { tool_approval: "approved" },
      output: [{ type: "text", text: "18C" }],
    });
    expect(secondModel.args.event.input).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Check the weather" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [{ type: "text", text: "18C" }],
          },
        ],
      },
    ]);
    expect(lastLog(secondModel)).toMatchObject({
      metrics: {
        completion_tokens: 4,
        prompt_tokens: 20,
        time_to_first_token: expect.any(Number),
        tokens: 24,
      },
      output: {
        role: "assistant",
        content: [{ type: "text", text: "It is 18C" }],
      },
    });
    expect(lastLog(turn)).toMatchObject({
      input: [
        {
          role: "user",
          content: [{ type: "text", text: "Check the weather" }],
        },
      ],
      metrics: {
        completion_tokens: 7,
        prompt_cache_creation_tokens: 1,
        prompt_cached_tokens: 2,
        prompt_tokens: 33,
        tokens: 40,
      },
      output: {
        role: "assistant",
        content: [{ type: "text", text: "It is 18C" }],
      },
    });
    expect(turn.end).toHaveBeenCalledTimes(1);
  });

  it("does not record an uncollected session stream", async () => {
    registerAnthropicInstrumentation();
    const handlers = handlersByName.get(
      "orchestrion:@anthropic-ai/sdk:beta.sessions.events.stream",
    );
    const stream = sessionStream([
      { id: "running", type: "session.status_running" },
      {
        id: "idle",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    ]);
    const context = { arguments: ["session-1"] };

    handlers.start(context);
    handlers.asyncEnd(Object.assign(context, { result: stream }));
    for await (const _event of stream) {
      // Consume the stream without opting into collection.
    }

    expect(spans).toEqual([]);
  });

  it("uses a distinct task name for thread streams and records denials", async () => {
    registerAnthropicInstrumentation();
    const handlers = handlersByName.get(
      "orchestrion:@anthropic-ai/sdk:beta.sessions.threads.events.stream",
    );
    const stream = sessionStream([
      { id: "running", type: "session.thread_status_running" },
      {
        id: "tool-denied",
        type: "agent.mcp_tool_use",
        name: "delete_file",
        input: { path: "notes.txt" },
        evaluated_permission: "ask",
      },
      {
        id: "confirmation",
        type: "user.tool_confirmation",
        tool_use_id: "tool-denied",
        result: "deny",
      },
      {
        id: "idle",
        type: "session.thread_status_idle",
        stop_reason: { type: "end_turn" },
      },
    ]);
    const context = {
      arguments: ["thread-1", { session_id: "session-1" }],
    };

    handlers.start(context);
    handlers.asyncEnd(Object.assign(context, { result: stream }));
    expect(collectAnthropicSession(stream)).toBe(stream);
    for await (const _event of stream) {
      // Consume the stream.
    }

    expect(spans[0].args.name).toBe("anthropic.beta.sessions.thread.turn");
    expect(spans[1].args.name).toBe("delete_file");
    expect(lastLog(spans[1])).toEqual({
      metadata: { tool_approval: "denied" },
    });
    expect(spans.every((span) => span.end.mock.calls.length === 1)).toBe(true);
  });
});

type TestSpan = {
  args: any;
  end: ReturnType<typeof vi.fn<() => void>>;
  log: ReturnType<typeof vi.fn<(event: unknown) => void>>;
  parent?: TestSpan;
};

function sessionStream(events: unknown[]) {
  return {
    abort: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
) {
  return {
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

function lastLog(span: TestSpan) {
  return span.log.mock.calls.at(-1)?.[0];
}
