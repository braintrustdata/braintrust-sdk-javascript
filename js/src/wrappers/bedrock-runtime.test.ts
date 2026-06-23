import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { configureNode } from "../node/config";
import { _exportsForTestingOnly, initLogger } from "../logger";
import { wrapBedrockRuntime } from "./bedrock-runtime";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

class ConverseCommand {
  constructor(public input: Record<string, unknown>) {}
}

class ConverseStreamCommand {
  constructor(public input: Record<string, unknown>) {}
}

class ListFoundationModelsCommand {
  constructor(public input: Record<string, unknown>) {}
}

describe("bedrock runtime wrapper", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectId: "test-project-id",
      projectName: "bedrock-runtime.test.ts",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  test("returns original object for unsupported clients", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = { foo: "bar" };

    expect(wrapBedrockRuntime(invalid)).toBe(invalid);
    expect(warnSpy).toHaveBeenCalledWith(
      "Unsupported Bedrock Runtime library. Not wrapping.",
    );
  });

  test("wraps supported send operations and preserves callback calls", async () => {
    async function* stream() {
      yield {
        messageStart: {
          role: "assistant",
        },
      };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: {
            text: "STREAM",
          },
        },
      };
      yield {
        messageStop: {
          stopReason: "end_turn",
        },
      };
      yield {
        metadata: {
          metrics: {
            latencyMs: 42,
          },
          usage: {
            inputTokens: 4,
            outputTokens: 1,
            totalTokens: 5,
          },
        },
      };
    }

    const send = vi.fn(
      (
        command:
          | ConverseCommand
          | ConverseStreamCommand
          | ListFoundationModelsCommand,
        optionsOrCb?: unknown,
      ) => {
        if (typeof optionsOrCb === "function") {
          optionsOrCb(null, { callback: true });
          return undefined;
        }

        if (command instanceof ConverseStreamCommand) {
          return Promise.resolve({ stream: stream() });
        }

        if (command instanceof ConverseCommand) {
          return Promise.resolve({
            metrics: {
              latencyMs: 123,
            },
            output: {
              message: {
                content: [{ text: "OK" }],
                role: "assistant",
              },
            },
            stopReason: "end_turn",
            usage: {
              inputTokens: 5,
              outputTokens: 2,
              totalTokens: 7,
            },
          });
        }

        return Promise.resolve({ ignored: true });
      },
    );

    const wrapped = wrapBedrockRuntime({
      send,
      destroy() {
        return this;
      },
    });

    expect(wrapped.destroy()).toBe(wrapped);

    await wrapped.send(
      new ConverseCommand({
        inferenceConfig: {
          maxTokens: 12,
          temperature: 0,
        },
        messages: [
          {
            content: [{ text: "Reply with exactly OK." }],
            role: "user",
          },
        ],
        modelId: "us.amazon.nova-lite-v1:0",
      }),
    );

    const response = await wrapped.send(
      new ConverseStreamCommand({
        messages: [
          {
            content: [{ text: "Reply with exactly STREAM." }],
            role: "user",
          },
        ],
        modelId: "us.amazon.nova-lite-v1:0",
      }),
    );
    for await (const _chunk of response.stream) {
      // Consume the stream so chunk aggregation runs.
    }

    await wrapped.send(new ListFoundationModelsCommand({}));
    wrapped.send(new ConverseCommand({}), () => {});

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(2);

    const converseSpan = spans.find(
      (span: any) => span.span_attributes?.name === "bedrock.converse",
    ) as Record<string, any> | undefined;
    const streamSpan = spans.find(
      (span: any) => span.span_attributes?.name === "bedrock.converseStream",
    ) as Record<string, any> | undefined;

    expect(converseSpan?.metadata).toMatchObject({
      command: "ConverseCommand",
      maxTokens: 12,
      model: "us.amazon.nova-lite-v1:0",
      operation: "converse",
      provider: "aws-bedrock",
      stopReason: "end_turn",
      temperature: 0,
    });
    expect(converseSpan?.input).toEqual({
      messages: [
        {
          content: [{ text: "Reply with exactly OK." }],
          role: "user",
        },
      ],
      system: undefined,
    });
    expect(converseSpan?.output).toEqual({
      content: [{ text: "OK" }],
      role: "assistant",
    });
    expect(converseSpan?.metrics).toMatchObject({
      completion_tokens: 2,
      latency_ms: 123,
      prompt_tokens: 5,
      tokens: 7,
    });

    expect(streamSpan?.metadata).toMatchObject({
      command: "ConverseStreamCommand",
      model: "us.amazon.nova-lite-v1:0",
      operation: "converseStream",
      provider: "aws-bedrock",
      stopReason: "end_turn",
    });
    expect(streamSpan?.output).toEqual({
      content: [{ text: "STREAM" }],
      role: "assistant",
    });
    expect(streamSpan?.metrics).toMatchObject({
      completion_tokens: 1,
      latency_ms: 42,
      prompt_tokens: 4,
      time_to_first_token: expect.any(Number),
      tokens: 5,
    });
  });

  test("wraps generated aggregated operation methods through proxy send", async () => {
    const send = vi.fn(async (command: ConverseCommand) => ({
      output: {
        message: {
          content: [{ text: "OK" }],
          role: "assistant",
        },
      },
      stopReason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    }));

    const wrapped = wrapBedrockRuntime({
      send,
      converse(this: { send: typeof send }, input: Record<string, unknown>) {
        return this.send(new ConverseCommand(input));
      },
    });

    await wrapped.converse({
      messages: [
        {
          content: [{ text: "Reply with exactly OK." }],
          role: "user",
        },
      ],
      modelId: "us.amazon.nova-lite-v1:0",
    });

    expect(send).toHaveBeenCalledTimes(1);

    const spans = await backgroundLogger.drain();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      output: {
        content: [{ text: "OK" }],
        role: "assistant",
      },
      span_attributes: {
        name: "bedrock.converse",
      },
    });
  });
});
