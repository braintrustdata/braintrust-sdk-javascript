import OpenAI from "openai";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import type { OpenAIChatChoice } from "../../vendor-sdk-types/openai";
import { wrapOpenAI } from "../../wrappers/oai";

describe("wrapped OpenAI reasoning_content", () => {
  let background: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    configureNode();
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    background = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openai-reasoning.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  // Constructed unit responses exercise SDK parsing and tracing, not a provider.
  function clientFor(body: string, streaming: boolean) {
    return wrapOpenAI(
      new OpenAI({
        apiKey: "unit-test-key",
        baseURL: "https://openai-compatible.invalid/v1",
        maxRetries: 0,
        fetch: async () =>
          new Response(body, {
            headers: {
              "content-type": streaming
                ? "text/event-stream"
                : "application/json",
            },
          }),
      }),
    );
  }

  async function recordedOutput() {
    const rows = (await background.drain()) as Array<{
      output?: OpenAIChatChoice[];
      metrics?: Record<string, number>;
    }>;
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it("records reasoning_content from interleaved streamed choices", async () => {
    const chunks = [
      {
        choices: [
          { index: 1, delta: { role: "assistant", reasoning_content: "One " } },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              reasoning_content: "Zero ",
              content: "A",
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 1,
            delta: { reasoning_content: "thought.", content: "B" },
            finish_reason: "stop",
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "thought.", content: "0" },
            finish_reason: "stop",
          },
        ],
      },
      {
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    ];
    const body =
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n";
    const client = clientFor(body, true);
    const stream = await client.chat.completions.create({
      model: "unit-test-model",
      messages: [{ role: "user", content: "Constructed unit input" }],
      stream: true,
      n: 2,
    });
    const received = [];
    for await (const chunk of stream) received.push(chunk);
    expect(received).toEqual(chunks);

    const row = await recordedOutput();
    expect(row.output?.map((choice) => choice.message.content)).toEqual([
      "A0",
      "B",
    ]);
    expect(row.output).toEqual([
      {
        index: 0,
        message: {
          role: "assistant",
          content: "A0",
          reasoning_content: "Zero thought.",
        },
        finish_reason: "stop",
        logprobs: null,
      },
      {
        index: 1,
        message: {
          role: "assistant",
          content: "B",
          reasoning_content: "One thought.",
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ]);
    expect(row.metrics).toMatchObject({
      prompt_tokens: 2,
      completion_tokens: 3,
      tokens: 5,
    });
  });

  it.each([undefined, null, "", "A thought."])(
    "preserves reasoning_content %s in streamed and nonstreaming span output",
    async (reasoningContent) => {
      const message = {
        role: "assistant",
        content: "Answer",
        ...(reasoningContent !== undefined
          ? { reasoning_content: reasoningContent }
          : {}),
      };
      const choices = [
        { index: 0, message, finish_reason: "stop", logprobs: null },
      ];
      const nonstreamingClient = clientFor(JSON.stringify({ choices }), false);
      const response = await nonstreamingClient.chat.completions.create({
        model: "unit-test-model",
        messages: [],
      });
      expect(response.choices).toEqual(choices);
      expect((await recordedOutput()).output).toEqual(choices);

      const streamingClient = clientFor(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        true,
      );
      const stream = await streamingClient.chat.completions.create({
        model: "unit-test-model",
        messages: [],
        stream: true,
      });
      for await (const _chunk of stream) {
        // Consume the stream so its span is finalized.
      }
      expect((await recordedOutput()).output).toEqual(choices);
    },
  );
});
