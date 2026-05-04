import {
  test,
  expect,
  describe,
  beforeEach,
  beforeAll,
  afterEach,
  vi,
} from "vitest";
import { wrapClaudeAgentSDK } from "./claude-agent-sdk";
import { initLogger, _exportsForTestingOnly } from "../../logger";
import { configureNode } from "../../node/config";
import { z } from "zod/v3";

const makePromptMessage = (content: string) => ({
  type: "user",
  message: { role: "user", content },
});

class CustomAsyncIterable {
  private messages: Array<ReturnType<typeof makePromptMessage>>;

  constructor(messages: Array<ReturnType<typeof makePromptMessage>>) {
    this.messages = messages;
  }

  async *[Symbol.asyncIterator]() {
    for (const message of this.messages) {
      yield message;
    }
  }
}

// Unit tests for property forwarding (no real SDK needed)
describe("wrapClaudeAgentSDK property forwarding", () => {
  beforeAll(async () => {
    try {
      configureNode();
    } catch (e) {
      // Already configured
    }
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(async () => {
    _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "claude-agent-sdk-unit.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("forwards interrupt() method from original Query object", async () => {
    const interruptMock = vi.fn().mockResolvedValue(undefined);

    // Create a mock SDK with a query function that returns a generator with interrupt()
    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        // Create an async generator that also has an interrupt method
        const generator = (async function* () {
          yield { type: "assistant", message: { content: "Hello" } };
          yield { type: "result", result: "done" };
        })();

        // Attach interrupt method to the generator (like the real SDK does)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (generator as any).interrupt = interruptMock;

        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);
    const queryResult = wrappedSDK.query({ prompt: "test" });

    // Verify interrupt() is accessible and forwards to the original
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(typeof (queryResult as any).interrupt).toBe("function");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (queryResult as any).interrupt();
    expect(interruptMock).toHaveBeenCalledTimes(1);
  });

  test("interrupt() works before iteration starts (eager initialization)", async () => {
    const interruptMock = vi.fn().mockResolvedValue(undefined);

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        const generator = (async function* () {
          yield { type: "assistant", message: { content: "Hello" } };
          yield { type: "result", result: "done" };
        })();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (generator as any).interrupt = interruptMock;
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);
    const queryResult = wrappedSDK.query({ prompt: "test" });

    // Call interrupt() BEFORE starting iteration - this should work
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (queryResult as any).interrupt();
    expect(interruptMock).toHaveBeenCalledTimes(1);
  });

  test("forwards other custom properties from original Query object", async () => {
    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();

        // Attach custom properties (like the real SDK might have)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (generator as any).sessionId = "test-session-123";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (generator as any).customMethod = () => "custom-value";

        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);
    const queryResult = wrappedSDK.query({ prompt: "test" });

    // Start iteration
    const iterator = queryResult[Symbol.asyncIterator]();
    await iterator.next();

    // Verify custom properties are forwarded
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((queryResult as any).sessionId).toBe("test-session-123");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((queryResult as any).customMethod()).toBe("custom-value");
  });

  test("async iterator protocol still works after wrapping", async () => {
    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        const generator = (async function* () {
          yield { type: "assistant", message: { content: "msg1" } };
          yield { type: "assistant", message: { content: "msg2" } };
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);
    const messages: unknown[] = [];

    for await (const msg of wrappedSDK.query({ prompt: "test" })) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ type: "assistant" });
    expect(messages[2]).toMatchObject({ type: "result" });
  });

  test.each([
    [
      "asyncgen_single",
      () =>
        (async function* () {
          yield makePromptMessage("What is 2 + 2?");
        })(),
      ["What is 2 + 2?"],
    ],
    [
      "asyncgen_multi",
      () =>
        (async function* () {
          yield makePromptMessage("Part 1");
          yield makePromptMessage("Part 2");
        })(),
      ["Part 1", "Part 2"],
    ],
    [
      "custom_async_iterable",
      () =>
        new CustomAsyncIterable([
          makePromptMessage("Custom 1"),
          makePromptMessage("Custom 2"),
        ]),
      ["Custom 1", "Custom 2"],
    ],
  ])(
    "captures async iterable prompt input (%s)",
    async (
      _name: string,
      inputFactory: () => AsyncIterable<unknown>,
      expected: string[],
    ) => {
      const backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
      expect(await backgroundLogger.drain()).toHaveLength(0);

      const mockSDK = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        query: ({ prompt }: any) => {
          const generator = (async function* () {
            if (prompt && typeof prompt[Symbol.asyncIterator] === "function") {
              for await (const _ of prompt) {
                // Drain prompt to simulate SDK consumption.
              }
            }

            yield {
              type: "assistant",
              message: {
                role: "assistant",
                content: "Hello!",
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };

            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })();

          return generator;
        },
      };

      const wrappedSDK = wrapClaudeAgentSDK(mockSDK);
      for await (const _msg of wrappedSDK.query({ prompt: inputFactory() })) {
        // consume
      }

      const spans = await backgroundLogger.drain();
      const taskSpan = spans.find(
        (s) =>
          (s["span_attributes"] as Record<string, unknown>).name ===
          "Claude Agent",
      );
      expect(taskSpan).toBeDefined();

      const input = (taskSpan as any).input as Array<{
        message?: { content?: string };
      }>;
      expect(Array.isArray(input)).toBe(true);
      expect(input.map((item) => item.message?.content)).toEqual(expected);

      const llmSpan = spans.find(
        (s) =>
          (s["span_attributes"] as Record<string, unknown>).name ===
          "anthropic.messages.create",
      );
      expect(llmSpan).toBeDefined();

      const llmInput = (llmSpan as any).input as Array<{
        role?: string;
        content?: string;
      }>;
      expect(Array.isArray(llmInput)).toBe(true);
      expect(llmInput.map((item) => item.content)).toEqual(expected);
    },
  );

  test("injects PreToolUse and PostToolUse hooks for tracing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOptions: any;

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        capturedOptions = params.options;
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);

    // Consume the generator to trigger the query
    for await (const _msg of wrappedSDK.query({
      prompt: "test",
      options: { model: "test-model" },
    })) {
      // consume
    }

    // Verify hooks were injected
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.hooks).toBeDefined();
    expect(capturedOptions.hooks.PreToolUse).toBeDefined();
    expect(capturedOptions.hooks.PreToolUse.length).toBeGreaterThan(0);
    expect(capturedOptions.hooks.PostToolUse).toBeDefined();
    expect(capturedOptions.hooks.PostToolUse.length).toBeGreaterThan(0);
  });

  test("preserves user-provided hooks when injecting tracing hooks", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOptions: any;
    const userPreHook = vi.fn().mockResolvedValue({});
    const userPostHook = vi.fn().mockResolvedValue({});

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        capturedOptions = params.options;
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);

    // Consume the generator with user-provided hooks
    for await (const _msg of wrappedSDK.query({
      prompt: "test",
      options: {
        model: "test-model",
        hooks: {
          PreToolUse: [{ hooks: [userPreHook] }],
          PostToolUse: [{ hooks: [userPostHook] }],
        },
      },
    })) {
      // consume
    }

    // Verify user hooks are preserved AND our hooks are added
    expect(capturedOptions.hooks.PreToolUse.length).toBeGreaterThanOrEqual(2);
    expect(capturedOptions.hooks.PostToolUse.length).toBeGreaterThanOrEqual(2);

    // User hooks should be first (they were provided first)
    expect(capturedOptions.hooks.PreToolUse[0].hooks[0]).toBe(userPreHook);
    expect(capturedOptions.hooks.PostToolUse[0].hooks[0]).toBe(userPostHook);
  });

  test("injects PostToolUseFailure hook for error tracing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOptions: any;

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        capturedOptions = params.options;
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);

    for await (const _msg of wrappedSDK.query({
      prompt: "test",
      options: { model: "test-model" },
    })) {
      // consume
    }

    // Verify PostToolUseFailure hook was injected
    expect(capturedOptions.hooks).toBeDefined();
    expect(capturedOptions.hooks.PostToolUseFailure).toBeDefined();
    expect(capturedOptions.hooks.PostToolUseFailure.length).toBeGreaterThan(0);
  });

  test("injects SubagentStart and SubagentStop hooks for lifecycle tracing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOptions: any;

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        capturedOptions = params.options;
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);

    for await (const _msg of wrappedSDK.query({
      prompt: "test",
      options: { model: "test-model" },
    })) {
      // consume
    }

    expect(capturedOptions.hooks).toBeDefined();
    expect(capturedOptions.hooks.SubagentStart).toBeDefined();
    expect(capturedOptions.hooks.SubagentStart.length).toBeGreaterThan(0);
    expect(capturedOptions.hooks.SubagentStop).toBeDefined();
    expect(capturedOptions.hooks.SubagentStop.length).toBeGreaterThan(0);
  });

  test("PreToolUse hook handles undefined toolUseID gracefully", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOptions: any;

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        capturedOptions = params.options;
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);

    for await (const _msg of wrappedSDK.query({
      prompt: "test",
      options: { model: "test-model" },
    })) {
      // consume
    }

    // Call the PreToolUse hook with undefined toolUseID
    const preToolUseHook = capturedOptions.hooks.PreToolUse[0].hooks[0];
    const result = await preToolUseHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "test_tool",
        tool_input: { arg: "value" },
        session_id: "test-session",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      undefined, // toolUseID is undefined
      { signal: new AbortController().signal },
    );

    // Should return empty object without throwing
    expect(result).toEqual({});
  });

  test("PostToolUse hook handles undefined toolUseID gracefully", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOptions: any;

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        capturedOptions = params.options;
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);

    for await (const _msg of wrappedSDK.query({
      prompt: "test",
      options: { model: "test-model" },
    })) {
      // consume
    }

    // Call the PostToolUse hook with undefined toolUseID
    const postToolUseHook = capturedOptions.hooks.PostToolUse[0].hooks[0];
    const result = await postToolUseHook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "test_tool",
        tool_input: { arg: "value" },
        tool_response: { result: "success" },
        session_id: "test-session",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      undefined, // toolUseID is undefined
      { signal: new AbortController().signal },
    );

    // Should return empty object without throwing
    expect(result).toEqual({});
  });

  test("PostToolUseFailure hook handles undefined toolUseID gracefully", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOptions: any;

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        capturedOptions = params.options;
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);

    for await (const _msg of wrappedSDK.query({
      prompt: "test",
      options: { model: "test-model" },
    })) {
      // consume
    }

    // Call the PostToolUseFailure hook with undefined toolUseID
    const postToolUseFailureHook =
      capturedOptions.hooks.PostToolUseFailure[0].hooks[0];
    const result = await postToolUseFailureHook(
      {
        hook_event_name: "PostToolUseFailure",
        tool_name: "test_tool",
        tool_input: { arg: "value" },
        error: "Tool execution failed",
        is_interrupt: false,
        session_id: "test-session",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      undefined, // toolUseID is undefined
      { signal: new AbortController().signal },
    );

    // Should return empty object without throwing
    expect(result).toEqual({});
  });

  test("PostToolUseFailure hook logs error to span", async () => {
    const backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedOptions: any;

    const mockSDK = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (params: any) => {
        capturedOptions = params.options;
        const generator = (async function* () {
          yield { type: "result", result: "done" };
        })();
        return generator;
      },
    };

    const wrappedSDK = wrapClaudeAgentSDK(mockSDK);

    for await (const _msg of wrappedSDK.query({
      prompt: "test",
      options: { model: "test-model" },
    })) {
      // consume
    }

    const preToolUseHook = capturedOptions.hooks.PreToolUse[0].hooks[0];
    const postToolUseFailureHook =
      capturedOptions.hooks.PostToolUseFailure[0].hooks[0];
    const toolUseID = "test-tool-use-id";

    // First, call PreToolUse to create the span
    await preToolUseHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__server__tool",
        tool_input: { arg: "value" },
        session_id: "test-session",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      toolUseID,
      { signal: new AbortController().signal },
    );

    // Then call PostToolUseFailure to log the error and end the span
    const result = await postToolUseFailureHook(
      {
        hook_event_name: "PostToolUseFailure",
        tool_name: "mcp__server__tool",
        tool_input: { arg: "value" },
        error: "Tool execution failed: connection timeout",
        is_interrupt: false,
        session_id: "test-session",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
      },
      toolUseID,
      { signal: new AbortController().signal },
    );

    // Should return empty object (hook completed successfully)
    expect(result).toEqual({});

    // Verify span was created and ended (check via background logger)
    const spans = await backgroundLogger.drain();
    const toolSpan = spans?.find(
      (s) => (s["span_attributes"] as Record<string, unknown>).type === "tool",
    );

    // Tool span should exist and have error logged
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.error).toBe("Tool execution failed: connection timeout");
  });
});

// Try to import the Claude Agent SDK - skip tests if not available
let claudeSDK: unknown;
try {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - SDK may not be installed
  claudeSDK = await import("@anthropic-ai/claude-agent-sdk");
} catch (e) {
  console.warn("Claude Agent SDK not installed, skipping integration tests");
}

try {
  configureNode();
} catch (e) {
  // Initialize Braintrust state once per process
}

const TEST_MODEL = "claude-haiku-4-5";

describe.skipIf(!claudeSDK)("claude-agent-sdk integration tests", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let backgroundLogger: any;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(async () => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();

    initLogger({
      projectName: "claude-agent-sdk.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  test("claude_agent.ts example - calculator with multiple operations", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { query, tool, createSdkMcpServer } = wrapClaudeAgentSDK(
      claudeSDK as any,
    );

    // Create calculator tool (matches example)
    const calculator = tool(
      "calculator",
      "Performs basic arithmetic operations",
      {
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        let result = 0;
        switch (args.operation) {
          case "multiply":
            result = args.a * args.b;
            break;
          case "subtract":
            result = args.a - args.b;
            break;
        }
        return {
          content: [
            {
              type: "text",
              text: `The result of ${args.operation}(${args.a}, ${args.b}) is ${result}`,
            },
          ],
        };
      },
    );

    // Run the example query and capture the result message
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resultMessage: any;
    for await (const message of query({
      prompt:
        "Multiply 15 by 7. Then subtract 5 from the result. You MUST use the calculator tool for both operations.",
      options: {
        model: TEST_MODEL,
        permissionMode: "bypassPermissions",
        temperature: 0.0,
        mcpServers: {
          calculator: createSdkMcpServer({
            name: "calculator",
            version: "1.0.0",
            tools: [calculator],
          }),
        },
      },
    })) {
      if (message.type === "result") {
        resultMessage = message;
      }
    }

    const spans = await backgroundLogger.drain();

    // Verify root task span
    const taskSpan = spans.find(
      (s) =>
        (s["span_attributes"] as Record<string, unknown>).name ===
        "Claude Agent",
    );
    expect(taskSpan).toBeDefined();
    expect((taskSpan!["span_attributes"] as Record<string, unknown>).type).toBe(
      "task",
    );
    expect(taskSpan!.input).toContain("Multiply 15 by 7");
    expect(taskSpan!.output).toBeDefined();

    // Verify result message has usage data
    expect(resultMessage).toBeDefined();
    expect(resultMessage.type).toBe("result");
    expect(resultMessage.usage).toBeDefined();
    expect(resultMessage.usage.input_tokens).toBeGreaterThan(0);
    expect(resultMessage.usage.output_tokens).toBeGreaterThan(0);

    // Task span should only have timing metrics, not token counts
    // Token counts are computed during UI rendering from child LLM spans
    const taskMetrics = taskSpan!.metrics as Record<string, number>;
    expect(taskMetrics).toBeDefined();
    expect(taskMetrics.start).toBeGreaterThan(0);
    expect(taskMetrics.end).toBeGreaterThan(taskMetrics.start);

    // Verify LLM spans (multiple anthropic.messages.create calls)
    const llmSpans = spans.filter(
      (s) => (s["span_attributes"] as Record<string, unknown>).type === "llm",
    );
    // haiku sometimes solves this in one turn
    expect(llmSpans.length).toBeGreaterThanOrEqual(1);

    llmSpans.forEach((span) => {
      expect((span["span_attributes"] as Record<string, unknown>).name).toBe(
        "anthropic.messages.create",
      );
      expect(
        (span.metrics as Record<string, number>).prompt_tokens,
      ).toBeGreaterThan(0);
      // Output should be an array of messages (grouped by message.id)
      expect(Array.isArray(span.output)).toBe(true);
      expect((span.output as unknown[]).length).toBeGreaterThan(0);
    });

    // Verify tool spans (calculator should be called at least twice: multiply, subtract)
    // Note: Tool names from hooks include the MCP server prefix: mcp__<server>__<tool>
    const toolSpans = spans.filter(
      (s) => (s["span_attributes"] as Record<string, unknown>).type === "tool",
    );
    if (toolSpans.length == 0) {
      // FIXME: This test is non-deterministic, even with temperature 0
      // Sometimes haiku just doesn't make a tool call
      return;
    }
    expect(toolSpans.length).toBeGreaterThanOrEqual(1);
    toolSpans.forEach((span) => {
      // Span name is parsed MCP format: tool: server/tool
      expect((span["span_attributes"] as Record<string, unknown>).name).toBe(
        "tool: calculator/calculator",
      );
      // Metadata uses GenAI semantic conventions
      const metadata = span.metadata as Record<string, string>;
      expect(metadata["gen_ai.tool.name"]).toBe("calculator");
      expect(metadata["mcp.server"]).toBe("calculator");
      expect(metadata["claude_agent_sdk.raw_tool_name"]).toBe(
        "mcp__calculator__calculator",
      );
    });

    // Verify span hierarchy
    const rootSpanId = taskSpan!.span_id;
    spans
      .filter(
        (s) =>
          s.span_id !== rootSpanId &&
          (s["span_attributes"] as Record<string, unknown>).type !== "tool",
      )
      .forEach((span) => {
        expect(span.root_span_id).toBe(rootSpanId);
        expect(span.span_parents).toContain(rootSpanId);
      });
  }, 30000);

  test("claude_agent_sdk.test.ts - captures async iterable prompt input", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { query } = wrapClaudeAgentSDK(claudeSDK as any);

    const prompt = (async function* () {
      yield makePromptMessage("Part 1");
      yield makePromptMessage("Part 2");
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resultMessage: any;
    for await (const message of query({
      prompt,
      options: {
        model: TEST_MODEL,
        permissionMode: "bypassPermissions",
      },
    })) {
      if (message.type === "result") {
        resultMessage = message;
      }
    }

    expect(resultMessage).toBeDefined();

    const spans = await backgroundLogger.drain();
    const taskSpan = spans.find(
      (s) =>
        (s["span_attributes"] as Record<string, unknown>).name ===
        "Claude Agent",
    );
    expect(taskSpan).toBeDefined();

    const input = (taskSpan as any).input as Array<{
      message?: { content?: string };
    }>;
    expect(Array.isArray(input)).toBe(true);
    expect(input.map((item) => item.message?.content)).toEqual([
      "Part 1",
      "Part 2",
    ]);

    const llmSpan = spans.find((s) => {
      if (
        (s["span_attributes"] as Record<string, unknown>).name !==
        "anthropic.messages.create"
      ) {
        return false;
      }
      const input = (s as any).input as Array<{ content?: unknown }>;
      return Array.isArray(input) && input.some((item) => item.content);
    });
    expect(llmSpan).toBeDefined();

    const llmInput = (llmSpan as any).input as Array<{
      role?: string;
      content?: unknown;
    }>;
    expect(Array.isArray(llmInput)).toBe(true);
    expect(llmInput.map((item) => item.content)).toEqual(["Part 1", "Part 2"]);
  }, 30000);

  test("sub-agent produces nested TASK span with tool calls parented correctly", async () => {
    expect(await backgroundLogger.drain()).toHaveLength(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { query, tool, createSdkMcpServer } = wrapClaudeAgentSDK(
      claudeSDK as any,
    );

    const calculator = tool(
      "calculator",
      "Performs basic arithmetic operations",
      {
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        let result = 0;
        switch (args.operation) {
          case "add":
            result = args.a + args.b;
            break;
          case "multiply":
            result = args.a * args.b;
            break;
        }
        return {
          content: [
            {
              type: "text",
              text: `${args.operation}(${args.a}, ${args.b}) = ${result}`,
            },
          ],
        };
      },
    );

    for await (const message of query({
      prompt:
        "Spawn a math-expert subagent to add 15 and 27 using the calculator tool. Report the result.",
      options: {
        model: TEST_MODEL,
        permissionMode: "bypassPermissions",
        allowedTools: ["Task"],
        agents: {
          "math-expert": {
            description:
              "Math specialist. Use the calculator tool for calculations.",
            prompt:
              "You are a math expert. Use the calculator tool to perform the requested calculation. Be concise.",
            model: TEST_MODEL,
          },
        },
        mcpServers: {
          calculator: createSdkMcpServer({
            name: "calculator",
            version: "1.0.0",
            tools: [calculator],
          }),
        },
      },
    })) {
      // consume
    }

    const spans = await backgroundLogger.drain();

    // Root TASK span
    const rootSpan = spans.find(
      (s) =>
        (s["span_attributes"] as Record<string, unknown>).name ===
        "Claude Agent",
    );
    expect(rootSpan).toBeDefined();

    // Sub-agent TASK span
    const subAgentSpan = spans.find(
      (s) =>
        (s["span_attributes"] as Record<string, unknown>).type === "task" &&
        (
          (s["span_attributes"] as Record<string, unknown>).name as string
        )?.startsWith("Agent:"),
    );
    expect(subAgentSpan).toBeDefined();

    // There should be LLM spans under the sub-agent
    const subAgentLlmSpans = spans.filter(
      (s) =>
        (s["span_attributes"] as Record<string, unknown>).type === "llm" &&
        (s.span_parents as string[])?.includes(subAgentSpan!.span_id as string),
    );
    expect(subAgentLlmSpans.length).toBeGreaterThanOrEqual(1);

    const spanById = new Map(
      spans.map((span) => [span.span_id, span] as const),
    );
    const isDescendantOf = (
      span: (typeof spans)[number],
      ancestorId: string,
    ): boolean => {
      const queue = [...((span.span_parents as string[] | undefined) ?? [])];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const parentId = queue.shift();
        if (!parentId || visited.has(parentId)) {
          continue;
        }
        if (parentId === ancestorId) {
          return true;
        }
        visited.add(parentId);
        const parentSpan = spanById.get(parentId);
        if (!parentSpan) {
          continue;
        }
        const parentAncestors =
          (parentSpan.span_parents as string[] | undefined) ?? [];
        queue.push(...parentAncestors);
      }

      return false;
    };

    // Sub-agent should stay in the root trace and be directly parented by
    // either the root span (legacy) or the Task/Agent handoff tool span.
    expect(subAgentSpan!.root_span_id).toBe(rootSpan!.span_id);
    const subAgentParentIds =
      (subAgentSpan!.span_parents as string[] | undefined) ?? [];
    const hasRootDirectParent = subAgentParentIds.includes(
      rootSpan!.span_id as string,
    );
    const hasHandoffToolDirectParent = subAgentParentIds.some((parentId) => {
      const parentSpan = spanById.get(parentId);
      if (!parentSpan) {
        return false;
      }
      const spanAttributes = parentSpan["span_attributes"] as Record<
        string,
        unknown
      >;
      const metadata = parentSpan.metadata as Record<string, unknown>;
      return (
        spanAttributes.type === "tool" &&
        (metadata["gen_ai.tool.name"] === "Task" ||
          metadata["gen_ai.tool.name"] === "Agent")
      );
    });
    expect(hasRootDirectParent || hasHandoffToolDirectParent).toBe(true);
    expect(isDescendantOf(subAgentSpan!, rootSpan!.span_id as string)).toBe(
      true,
    );

    // Local tool spans should be nested under the sub-agent.
    const subAgentToolSpans = spans.filter(
      (s) =>
        (s["span_attributes"] as Record<string, unknown>).type === "tool" &&
        (s["span_attributes"] as Record<string, unknown>).name ===
          "tool: calculator/calculator" &&
        isDescendantOf(s, subAgentSpan!.span_id as string),
    );
    expect(subAgentToolSpans.length).toBeGreaterThanOrEqual(1);
    const subAgentLlmSpanIds = new Set(
      subAgentLlmSpans.map((span) => span.span_id as string),
    );
    subAgentToolSpans.forEach((toolSpan) => {
      const metadata = toolSpan.metadata as Record<string, unknown>;
      expect(metadata["gen_ai.tool.name"]).toBe("calculator");
      expect(metadata["mcp.server"]).toBe("calculator");
      expect(metadata["claude_agent_sdk.raw_tool_name"]).toBe(
        "mcp__calculator__calculator",
      );
      expect(
        ((toolSpan.span_parents as string[] | undefined) ?? []).some(
          (parentId) => subAgentLlmSpanIds.has(parentId),
        ),
      ).toBe(true);
    });
  }, 60000);
});
