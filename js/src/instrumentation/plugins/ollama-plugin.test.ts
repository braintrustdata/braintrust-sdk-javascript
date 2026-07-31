import { describe, expect, it } from "vitest";
import {
  aggregateOllamaChatChunks,
  aggregateOllamaGenerateChunks,
  extractOllamaChatInput,
  extractOllamaChatOutput,
  extractOllamaEmbedOutput,
  extractOllamaEmbeddingsOutput,
  extractOllamaGenerateInput,
  extractOllamaMetrics,
} from "./ollama-plugin";

describe("Ollama instrumentation extraction", () => {
  it("normalizes chat inputs, tools, and supported request metadata", () => {
    const result = extractOllamaChatInput([
      {
        model: "gpt-oss:20b",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "get_weather",
                  arguments: { city: "Paris" },
                },
              },
            ],
          },
          {
            role: "tool",
            tool_name: "get_weather",
            content: '{"temperature":18}',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          },
        ],
        format: "json",
        options: {
          temperature: 0,
          top_p: 0.8,
          num_predict: 32,
          frequency_penalty: 0.1,
          presence_penalty: 0.2,
          stop: ["DONE"],
          top_k: 10,
        },
        stream: true,
      },
    ]);

    expect(result.input).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "What is the weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "ollama_call_get_weather_0",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "ollama_call_get_weather_0",
        content: '{"temperature":18}',
      },
    ]);
    expect(result.metadata).toEqual({
      provider: "ollama",
      model: "gpt-oss:20b",
      temperature: 0,
      top_p: 0.8,
      max_tokens: 32,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ["DONE"],
      response_format: "json",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ],
    });
  });

  it("converts multimodal chat images into attachments", () => {
    const result = extractOllamaChatInput([
      {
        model: "llava",
        messages: [
          {
            role: "user",
            content: "Describe this image.",
            images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"],
          },
        ],
      },
    ]);

    const content = (
      result.input as Array<{
        content: Array<{
          type: string;
          image_url?: { url?: { reference?: unknown } };
        }>;
      }>
    )[0].content;
    expect(content[0]).toEqual({
      type: "text",
      text: "Describe this image.",
    });
    expect(content[1]).toMatchObject({
      type: "image_url",
      image_url: {
        url: {
          reference: {
            type: "braintrust_attachment",
            content_type: "image/png",
          },
        },
      },
    });
  });

  it("normalizes chat output and tool calls as OpenAI choices", () => {
    expect(
      extractOllamaChatOutput({
        model: "gpt-oss:20b",
        message: {
          role: "assistant",
          content: "",
          thinking: "I should call the tool.",
          tool_calls: [
            {
              function: {
                name: "get_weather",
                arguments: { city: "Paris" },
              },
            },
          ],
        },
        done: true,
        done_reason: "stop",
      }),
    ).toEqual([
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          reasoning: "I should call the tool.",
          tool_calls: [
            {
              id: "ollama_call_get_weather_0",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
      },
    ]);
  });

  it("normalizes raw generation input as canonical messages", () => {
    expect(
      extractOllamaGenerateInput([
        {
          model: "gpt-oss:20b",
          system: "Be concise.",
          prompt: "Say OK.",
          options: { temperature: 0, num_predict: 8 },
        },
      ]),
    ).toEqual({
      input: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Say OK." },
      ],
      metadata: {
        provider: "ollama",
        model: "gpt-oss:20b",
        temperature: 0,
        max_tokens: 8,
      },
    });
  });

  it("extracts token metrics and ignores invalid counts", () => {
    expect(
      extractOllamaMetrics({
        prompt_eval_count: 7,
        eval_count: 3,
      }),
    ).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      tokens: 10,
    });
    expect(
      extractOllamaMetrics({
        prompt_eval_count: -1,
        eval_count: Number.NaN,
      }),
    ).toEqual({});
  });

  it("aggregates chat and generation streams into final outputs", () => {
    const chat = aggregateOllamaChatChunks(
      [
        {
          model: "gpt-oss:20b",
          message: { role: "assistant", content: "Hello" },
          done: false,
        },
        {
          model: "gpt-oss:20b",
          message: { role: "assistant", content: "!" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 5,
          eval_count: 2,
        },
      ],
      undefined,
      undefined,
      1,
    );
    expect(chat.output).toEqual([
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "Hello!" },
      },
    ]);
    expect(chat.metrics).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 2,
      tokens: 7,
    });
    expect(chat.metadata).toEqual({ model: "gpt-oss:20b" });

    const generation = aggregateOllamaGenerateChunks(
      [
        { model: "gpt-oss:20b", response: "O", done: false },
        {
          model: "gpt-oss:20b",
          response: "K",
          done: true,
          done_reason: "stop",
          prompt_eval_count: 4,
          eval_count: 2,
        },
      ],
      undefined,
      undefined,
      1,
    );
    expect(generation.output).toEqual([
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "OK" },
      },
    ]);
    expect(generation.metrics).toMatchObject({
      prompt_tokens: 4,
      completion_tokens: 2,
      tokens: 6,
    });
  });

  it("summarizes current and legacy embedding responses", () => {
    expect(
      extractOllamaEmbedOutput({
        model: "embeddinggemma",
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      }),
    ).toEqual({ embedding_length: 3 });
    expect(
      extractOllamaEmbeddingsOutput({
        embedding: [0.1, 0.2],
      }),
    ).toEqual({ embedding_length: 2 });
  });
});
