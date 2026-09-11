import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { wrapLangGraphSDK } from "../../wrappers/langgraph-sdk";
import { langGraphSDKChannels } from "./langgraph-sdk-channels";

configureNode();

describe("LangGraph SDK instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "tmp-luca-langgraph-sdk-test",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("preserves promise identity and helpers", async () => {
    const promise = Object.assign(Promise.resolve({ answer: "yes" }), {
      helper: () => "helper",
    });
    const result = langGraphSDKChannels.wait.invoke(
      () => promise,
      undefined,
      [null, "agent", { input: "question" }],
      {},
    );
    expect(result).toBe(promise);
    expect(result.helper()).toBe("helper");
    await result;
    expect(await backgroundLogger.drain()).toMatchObject([
      { input: "question", output: { answer: "yes" } },
    ]);
  });

  it("preserves synchronous exceptions and rejected error identity", async () => {
    const error = new Error("original failure");
    expect(() =>
      langGraphSDKChannels.wait.invoke(
        () => {
          throw error;
        },
        undefined,
        [null, "agent"],
        {},
      ),
    ).toThrow(error);
    await expect(
      langGraphSDKChannels.wait.invoke(
        () => Promise.reject(error),
        undefined,
        [null, "agent"],
        {},
      ),
    ).rejects.toBe(error);
    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);
    for (const span of spans)
      expect(span).toMatchObject({
        error: expect.stringContaining("original failure"),
        metrics: { end: expect.any(Number) },
      });
  });

  it("contains extraction failures without calling the provider twice", async () => {
    let calls = 0;
    const options = {
      get input(): unknown {
        throw new Error("hostile getter");
      },
    };
    const result = langGraphSDKChannels.wait.invoke(
      async () => {
        calls++;
        return "result";
      },
      undefined,
      [null, "agent", options],
      {},
    );
    await expect(result).resolves.toBe("result");
    expect(calls).toBe(1);
  });

  it("retains partial output and ends a stream when its iterator rejects", async () => {
    const error = new Error("connection lost");
    const original = (async function* () {
      yield { event: "values", data: { answer: "partial" } };
      throw error;
    })();
    const result = langGraphSDKChannels.stream.invoke(
      () => original,
      undefined,
      [null, "agent"],
      {},
    );
    expect(result).toBe(original);
    await result.next();
    await expect(result.next()).rejects.toBe(error);
    expect(await backgroundLogger.drain()).toMatchObject([
      {
        output: { answer: "partial" },
        error: expect.stringContaining("connection lost"),
        metrics: { end: expect.any(Number) },
      },
    ]);
  });

  it("does not interpret acknowledgements or empty message deltas as tokens", async () => {
    const stream = langGraphSDKChannels.stream.invoke(
      async function* () {
        yield { event: "metadata", data: { run_id: "run" } };
        yield { event: "messages", data: [{ content: "", id: "message" }, {}] };
      },
      undefined,
      [null, "agent"],
      {},
    );
    for await (const _ of stream) {
      /* drain */
    }
    const [span] = await backgroundLogger.drain();
    expect(span).not.toHaveProperty("metrics.time_to_first_token");
  });

  it("captures reported usage without counting messages from previous turns", async () => {
    const previous = {
      id: "previous",
      type: "ai",
      content: "earlier",
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 100,
        total_tokens: 200,
      },
    };
    const answer = {
      id: "answer",
      type: "ai",
      content: "new",
      usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    await langGraphSDKChannels.wait.invoke(
      async () => ({ messages: [previous, answer] }),
      undefined,
      [null, "agent", { input: { messages: [previous] } }],
      {},
    );
    expect(await backgroundLogger.drain()).toMatchObject([
      { metrics: { prompt_tokens: 3, completion_tokens: 2, tokens: 5 } },
    ]);
  });

  it("preserves a null streamed graph value", async () => {
    const stream = langGraphSDKChannels.stream.invoke(
      async function* () {
        yield { event: "values", data: null };
      },
      undefined,
      [null, "agent"],
      {},
    );
    for await (const _ of stream) {
      /* drain */
    }
    expect(await backgroundLogger.drain()).toMatchObject([{ output: null }]);
  });

  it("logs generated tool calls without repeating input or unrelated graph state", async () => {
    const content = [
      {
        type: "image_url",
        image_url: { url: "https://example.com/image.png" },
      },
    ];
    const state = Object.freeze({
      messages: [
        {
          type: "human",
          content,
          additional_kwargs: {},
          response_metadata: {},
        },
        {
          id: "answer",
          type: "ai",
          content: "",
          additional_kwargs: {},
          response_metadata: { internal: "omit" },
          tool_calls: [
            { id: "call-1", name: "search", args: { query: "hello" } },
          ],
          invalid_tool_calls: [],
          tool_call_chunks: [],
          usage_metadata: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
          },
        },
        {
          type: "tool",
          content: "found",
          name: "search",
          tool_call_id: "call-1",
        },
      ],
      application_state: { additional_kwargs: { preserve: true }, score: 0.9 },
    });
    const result = await langGraphSDKChannels.wait.invoke(
      async () => state,
      undefined,
      [null, "agent", { input: { ...state, messages: [state.messages[0]] } }],
      {},
    );
    expect(result).toBe(state);
    expect(state.messages[1]).toHaveProperty("usage_metadata");
    const [span] = await backgroundLogger.drain();
    const normalized = {
      messages: [
        { role: "user", content },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search", arguments: '{"query":"hello"}' },
            },
          ],
        },
        {
          role: "tool",
          content: "found",
          name: "search",
          tool_call_id: "call-1",
        },
      ],
      application_state: state.application_state,
    };
    expect(span).toHaveProperty("input", {
      ...normalized,
      messages: [normalized.messages[0]],
    });
    expect(span).toHaveProperty("output", normalized.messages[1]);
  });

  it("combines message deltas and update snapshots into the generated response", async () => {
    const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5 };
    const stream = langGraphSDKChannels.stream.invoke(
      async function* () {
        yield {
          event: "messages",
          data: [
            { id: "answer", type: "AIMessageChunk", content: "hello " },
            {},
          ],
        };
        yield {
          event: "messages",
          data: [
            {
              id: "answer",
              type: "AIMessageChunk",
              content: "world",
              usage_metadata: usage,
            },
            {},
          ],
        };
        yield {
          event: "updates",
          data: {
            agent: {
              messages: [
                {
                  id: "answer",
                  type: "ai",
                  content: "hello world",
                  usage_metadata: usage,
                },
              ],
              score: 0.9,
            },
          },
        };
      },
      undefined,
      [null, "agent"],
      {},
    );
    for await (const _ of stream) {
      /* drain */
    }
    const [span] = await backgroundLogger.drain();
    expect(span).toHaveProperty("output", {
      role: "assistant",
      content: "hello world",
    });
    expect(span).toMatchObject({
      metrics: { prompt_tokens: 3, completion_tokens: 2, tokens: 5 },
    });
  });

  it.each(["", "Error: "])(
    "unwraps serialized remote errors with prefix '%s' only in logged data",
    async (prefix) => {
      const error = new Error(
        prefix +
          JSON.stringify({ error: "ValueError", message: "Agent failed" }),
      );
      const returned = {
        __error__: { error: "Error", message: error.message },
      };
      await expect(
        langGraphSDKChannels.wait.invoke(
          async () => {
            throw error;
          },
          undefined,
          [null, "failing"],
          {},
        ),
      ).rejects.toBe(error);
      expect(
        await langGraphSDKChannels.wait.invoke(
          async () => returned,
          undefined,
          [null, "failing"],
          {},
        ),
      ).toBe(returned);
      const spans = await backgroundLogger.drain();
      expect(spans).toHaveLength(2);
      for (const span of spans)
        expect(span).toHaveProperty("error", "Agent failed");
      expect(spans[1]).not.toHaveProperty("output");
    },
  );

  it.each(["wait", "values", "updates", "messages"])(
    "logs only the final generated response for %s, preserving media and total usage",
    async (mode) => {
      const input = {
        messages: [
          {
            id: "old",
            type: "ai",
            content: "Earlier answer",
            usage_metadata: { total_tokens: 100 },
          },
          { id: "prompt", type: "human", content: "New question" },
        ],
      };
      const generated = [
        {
          id: "plan",
          type: "ai",
          content: "",
          tool_calls: [{ id: "call", name: "search", args: {} }],
          usage_metadata: { total_tokens: 4 },
        },
        {
          id: "tool",
          type: "tool",
          content: "Internal tool result",
          tool_call_id: "call",
        },
        {
          id: "answer",
          type: "ai",
          content: [
            { type: "text", text: "Final answer" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/generated.png" },
            },
          ],
          usage_metadata: { total_tokens: 9 },
        },
      ];
      const state = {
        messages: [...input.messages, ...generated],
        internal_state: "Do not display",
      };
      if (mode === "wait") {
        const result = await langGraphSDKChannels.wait.invoke(
          async () => state,
          undefined,
          [null, "agent", { input }],
          {},
        );
        expect(result).toBe(state);
      } else {
        const stream = langGraphSDKChannels.stream.invoke(
          async function* () {
            if (mode === "values") {
              yield { event: "values", data: input };
              yield { event: "values", data: state };
            } else if (mode === "updates") {
              yield {
                event: "updates",
                data: {
                  agent: {
                    messages: generated,
                    internal_state: state.internal_state,
                  },
                },
              };
            } else {
              for (const message of generated.filter(
                (message) => message.type === "ai",
              ))
                yield { event: "messages", data: [message, {}] };
            }
          },
          undefined,
          [null, "agent", { input }],
          {},
        );
        for await (const _ of stream) {
          /* drain */
        }
      }
      const [span] = await backgroundLogger.drain();
      expect(span).toHaveProperty("output", {
        role: "assistant",
        content: generated[2].content,
      });
      expect(span).toMatchObject({ metrics: { tokens: 13 } });
      expect(state.messages).toHaveLength(5);
      expect(state.internal_state).toBe("Do not display");
    },
  );

  it.each([
    {
      input: [{ role: "assistant", content: "same" }],
      messages: [{ role: "assistant", content: "same" }],
      output: undefined,
    },
    {
      input: [
        { role: "assistant", content: "same" },
        { role: "user", content: "again" },
      ],
      messages: [
        { role: "assistant", content: "same" },
        { role: "user", content: "again" },
        { role: "assistant", content: "same" },
      ],
      output: { role: "assistant", content: "same" },
    },
    {
      input: [{ id: "old", role: "assistant", content: "same" }],
      messages: [{ id: "new", role: "assistant", content: "same" }],
      output: { role: "assistant", content: "same" },
    },
    {
      input: [{ id: "answer", role: "assistant", content: "old" }],
      messages: [{ id: "answer", role: "assistant", content: "updated" }],
      output: { role: "assistant", content: "updated" },
    },
  ])(
    "distinguishes echoed history from generated or edited messages ($output)",
    async ({ input, messages, output }) => {
      await langGraphSDKChannels.wait.invoke(
        async () => ({ messages }),
        undefined,
        [null, "agent", { input: { messages: input } }],
        {},
      );
      const [span] = await backgroundLogger.drain();
      if (output === undefined) expect(span).not.toHaveProperty("output");
      else expect(span).toHaveProperty("output", output);
    },
  );

  it.each(["wait", "values", "updates"])(
    "records %s interrupts as metadata without presenting history as output",
    async (mode) => {
      const input = {
        messages: [{ id: "old", role: "assistant", content: "Earlier answer" }],
      };
      const interrupts = [{ id: "approval", value: "Approve?" }];
      const state = { ...input, __interrupt__: interrupts };
      if (mode === "wait") {
        expect(
          await langGraphSDKChannels.wait.invoke(
            async () => state,
            undefined,
            ["existing-thread", "agent", { command: { resume: "yes" } }],
            {},
          ),
        ).toBe(state);
      } else {
        const stream = langGraphSDKChannels.stream.invoke(
          async function* () {
            yield {
              event: mode,
              data: mode === "values" ? state : { __interrupt__: interrupts },
            };
          },
          undefined,
          ["existing-thread", "agent", { command: { resume: "yes" } }],
          {},
        );
        for await (const _ of stream) {
          /* drain */
        }
      }
      const [span] = await backgroundLogger.drain();
      expect(span).not.toHaveProperty("output");
      expect(span).not.toHaveProperty("error");
      expect(span).toMatchObject({
        metadata: { "langgraph.interrupts": interrupts },
        metrics: { end: expect.any(Number) },
      });
    },
  );

  it("keeps generated stream content when the last state snapshot contains only input", async () => {
    const input = { messages: [{ role: "user", content: "Question" }] };
    const stream = langGraphSDKChannels.stream.invoke(
      async function* () {
        yield { event: "values", data: input };
        yield {
          event: "messages",
          data: [
            { id: "answer", type: "AIMessageChunk", content: "Partial answer" },
            {},
          ],
        };
        throw new Error("Connection closed");
      },
      undefined,
      [null, "agent", { input }],
      {},
    );
    await stream.next();
    await stream.next();
    await expect(stream.next()).rejects.toThrow("Connection closed");
    const [span] = await backgroundLogger.drain();
    expect(span).toHaveProperty("output", {
      role: "assistant",
      content: "Partial answer",
    });
    expect(span).toHaveProperty("error", "Connection closed");
  });

  it("leaves unsupported wrapper inputs untouched", () => {
    for (const value of [null, undefined, {}, { runs: {} }])
      expect(wrapLangGraphSDK(value)).toBe(value);
  });
});
