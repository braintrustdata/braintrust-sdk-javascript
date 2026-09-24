import { describe, it, expect, vi } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

import {
  parseMetricsFromUsage,
  aggregateAnthropicStreamChunks,
  processAttachmentsInInput,
  coalesceInput,
} from "./anthropic-plugin";
import {
  extractAnthropicInput,
  extractAnthropicInputMetadata,
  extractAnthropicOutputMetadata,
} from "./anthropic-span-data";
import { Attachment } from "../../logger";

const parseMetricsFromUsageForTest = (usage: unknown) =>
  parseMetricsFromUsage(usage as any);
const aggregateAnthropicStreamChunksForTest = (chunks: unknown[]) =>
  aggregateAnthropicStreamChunks(chunks as any);

// Mock startSpan from logger
vi.mock("../../logger", () => ({
  startSpan: vi.fn(() => ({
    log: vi.fn(),
    end: vi.fn(),
  })),
  _internalGetGlobalState: vi.fn(() => undefined),
  Attachment: class Attachment {
    reference: any;
    constructor(opts: any) {
      this.reference = {
        filename: opts.filename,
        content_type: opts.contentType,
      };
    }
  },
}));

describe("parseMetricsFromUsage", () => {
  it("should return empty object for null usage", () => {
    expect(parseMetricsFromUsageForTest(null)).toEqual({});
  });

  it("should return empty object for undefined usage", () => {
    expect(parseMetricsFromUsageForTest(undefined)).toEqual({});
  });

  it("should map Anthropic token names to Braintrust names", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
    };

    const result = parseMetricsFromUsageForTest(usage);

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
    });
  });

  it("should handle cache_read_input_tokens", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 25,
    };

    const result = parseMetricsFromUsageForTest(usage);

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_cached_tokens: 25,
    });
  });

  it("should handle cache_creation_input_tokens", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 30,
    };

    const result = parseMetricsFromUsageForTest(usage);

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_cache_creation_tokens: 30,
    });
  });

  it("should handle all token types together", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 30,
    };

    const result = parseMetricsFromUsageForTest(usage);

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_cached_tokens: 25,
      prompt_cache_creation_tokens: 30,
    });
  });

  it("should surface the per-TTL cache creation breakdown", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 30,
      cache_creation: {
        ephemeral_1h_input_tokens: 10,
        ephemeral_5m_input_tokens: 20,
      },
    };

    const result = parseMetricsFromUsageForTest(usage);

    // The aggregate is still parsed here; `finalizeAnthropicTokens` removes it
    // only when the per-TTL representation accounts for the full total.
    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_cached_tokens: 25,
      prompt_cache_creation_tokens: 30,
      prompt_cache_creation_1h_tokens: 10,
      prompt_cache_creation_5m_tokens: 20,
    });
  });

  it("should ignore a null or partial cache creation breakdown", () => {
    expect(
      parseMetricsFromUsageForTest({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation: null,
      }),
    ).toEqual({ prompt_tokens: 100, completion_tokens: 50 });

    expect(
      parseMetricsFromUsageForTest({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 20 },
      }),
    ).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_cache_creation_5m_tokens: 20,
    });
  });

  it("should map output_tokens_details.thinking_tokens to completion_reasoning_tokens", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 80,
      output_tokens_details: {
        thinking_tokens: 20,
      },
    };

    const result = parseMetricsFromUsageForTest(usage);

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 80,
      completion_reasoning_tokens: 20,
    });
  });

  it("should ignore a null or non-number output token breakdown", () => {
    expect(
      parseMetricsFromUsageForTest({
        input_tokens: 100,
        output_tokens: 80,
        output_tokens_details: null,
      }),
    ).toEqual({ prompt_tokens: 100, completion_tokens: 80 });

    expect(
      parseMetricsFromUsageForTest({
        input_tokens: 100,
        output_tokens: 80,
        output_tokens_details: { thinking_tokens: "not a number" },
      }),
    ).toEqual({ prompt_tokens: 100, completion_tokens: 80 });
  });

  it("should ignore invalid token values", () => {
    const usage = {
      input_tokens: "not a number",
      output_tokens: 50,
      cache_read_input_tokens: Number.NaN,
      cache_creation_input_tokens: Number.POSITIVE_INFINITY,
      cache_creation: {
        ephemeral_1h_input_tokens: -1,
        ephemeral_5m_input_tokens: 1.5,
      },
      output_tokens_details: { thinking_tokens: -1 },
    };

    const result = parseMetricsFromUsageForTest(usage);

    expect(result).toEqual({
      completion_tokens: 50,
    });
  });

  it("should handle empty usage object", () => {
    expect(parseMetricsFromUsageForTest({})).toEqual({});
  });

  it("should omit server_tool_use metrics", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      server_tool_use: {
        web_search_requests: 3,
        ignored: "not-a-number",
      },
    };

    const result = parseMetricsFromUsageForTest(usage);

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
    });
  });

  it("should not turn future server tool fields into custom metrics", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      server_tool_use: {
        web_fetch_requests: 2,
        tool_search_requests: 4,
      },
    };

    const result = parseMetricsFromUsageForTest(usage);

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
    });
  });
});

describe("extractAnthropicOutputMetadata", () => {
  it("uses the resolved response model", () => {
    expect(
      extractAnthropicOutputMetadata({
        model: "claude-resolved",
        stop_reason: "end_turn",
        stop_sequence: null,
      } as any),
    ).toEqual({
      model: "claude-resolved",
      stop_reason: "end_turn",
      stop_sequence: null,
    });
  });
});

describe("extractAnthropicInput", () => {
  it("can omit tools while retaining allowlisted request metadata", () => {
    expect(
      extractAnthropicInputMetadata(
        {
          max_iterations: 3,
          max_tokens: 64,
          messages: [],
          model: "claude-test",
          secret_future_field: "do not capture",
          tools: [
            {
              input_schema: { type: "object" },
              name: "get_weather",
            },
          ],
        },
        { includeTools: false },
      ),
    ).toEqual({
      max_tokens: 64,
      model: "claude-test",
      provider: "anthropic",
    });
  });

  it("allowlists request metadata and normalizes tool configuration", () => {
    const { metadata } = extractAnthropicInput({
      max_tokens: 64,
      messages: [{ role: "user", content: "weather" }],
      model: "claude-test",
      secret_future_field: "do not capture",
      tool_choice: {
        disable_parallel_tool_use: true,
        name: "get_weather",
        type: "tool",
      },
      tools: [
        {
          description: "Get weather",
          input_schema: {
            properties: { location: { type: "string" } },
            type: "object",
          },
          name: "get_weather",
          type: null,
        },
      ],
    });

    expect(metadata).toEqual({
      max_tokens: 64,
      model: "claude-test",
      parallel_tool_calls: false,
      provider: "anthropic",
      tool_choice: {
        function: { name: "get_weather" },
        type: "function",
      },
      tools: [
        {
          function: {
            description: "Get weather",
            name: "get_weather",
            parameters: {
              properties: { location: { type: "string" } },
              type: "object",
            },
          },
          type: "function",
        },
      ],
    });
    expect(metadata).not.toHaveProperty("secret_future_field");
  });

  it("keeps allowlisted Anthropic built-in tools provider-native", () => {
    const { metadata } = extractAnthropicInput({
      max_tokens: 64,
      messages: [{ role: "user", content: "search" }],
      model: "claude-test",
      tool_choice: { type: "any" },
      tools: [
        {
          allowed_callers: ["direct"],
          defer_loading: true,
          max_uses: 1,
          name: "web_search",
          provider_future_field: "omit",
          response_inclusion: "excluded",
          strict: true,
          type: "web_search_20250305",
          user_location: { city: "Paris", type: "approximate" },
        },
        {
          allowed_domains: ["example.com"],
          citations: { enabled: true },
          max_content_tokens: 2048,
          name: "web_fetch",
          type: "web_fetch_20260318",
          use_cache: false,
        },
        {
          display_height_px: 768,
          display_width_px: 1024,
          enable_zoom: true,
          input_examples: [{ action: "screenshot" }],
          name: "computer",
          type: "computer_20251124",
        },
        {
          cache_control: { type: "ephemeral" },
          configs: { search: { defer_loading: true } },
          default_config: { enabled: true },
          mcp_server_name: "docs",
          type: "mcp_toolset",
        },
      ],
    });

    expect(metadata).toMatchObject({
      tool_choice: "required",
      tools: [
        {
          allowed_callers: ["direct"],
          defer_loading: true,
          max_uses: 1,
          name: "web_search",
          response_inclusion: "excluded",
          strict: true,
          type: "web_search_20250305",
          user_location: { city: "Paris", type: "approximate" },
        },
        {
          allowed_domains: ["example.com"],
          citations: { enabled: true },
          max_content_tokens: 2048,
          name: "web_fetch",
          type: "web_fetch_20260318",
          use_cache: false,
        },
        {
          display_height_px: 768,
          display_width_px: 1024,
          enable_zoom: true,
          input_examples: [{ action: "screenshot" }],
          name: "computer",
          type: "computer_20251124",
        },
        {
          cache_control: { type: "ephemeral" },
          configs: { search: { defer_loading: true } },
          default_config: { enabled: true },
          mcp_server_name: "docs",
          type: "mcp_toolset",
        },
      ],
    });
    expect((metadata.tools as unknown[])[0]).not.toHaveProperty(
      "provider_future_field",
    );
  });
});

describe("aggregateAnthropicStreamChunks", () => {
  it("should aggregate simple text chunks", () => {
    const chunks = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 0,
          },
        },
      },
      {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Hello",
        },
      },
      {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: " world",
        },
      },
      {
        type: "message_delta",
        usage: {
          output_tokens: 5,
        },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toBe("Hello world");
    expect(result.metrics).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
    });
  });

  it("should extract the resolved model and initial usage from message_start", () => {
    const chunks = [
      {
        type: "message_start",
        message: {
          model: "claude-resolved",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 50,
          },
        },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.metadata).toEqual({ model: "claude-resolved" });
    // finalizeAnthropicTokens adds all cache tokens to prompt_tokens
    expect(result.metrics).toMatchObject({
      prompt_tokens: 150, // 100 + 50
      prompt_cached_tokens: 50,
      tokens: 150, // prompt_tokens + completion_tokens (0)
    });
  });

  it("should carry thinking tokens through from message_delta without double counting", () => {
    const chunks = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 0,
          },
        },
      },
      {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
      {
        type: "message_delta",
        usage: {
          output_tokens: 80,
          output_tokens_details: { thinking_tokens: 20 },
        },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.metrics).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 80,
      completion_reasoning_tokens: 20,
      tokens: 90,
    });
  });

  it("should concatenate multiple text deltas", () => {
    const chunks = [
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "The " },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "quick " },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "brown " },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "fox" },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toBe("The quick brown fox");
  });

  it("should merge usage from message_start and message_delta", () => {
    const chunks = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
          },
        },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hi" },
      },
      {
        type: "message_delta",
        usage: {
          output_tokens: 10,
        },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.metrics).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 10,
    });
  });

  it("should extract stop_reason from message_delta", () => {
    const chunks = [
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Done" },
      },
      {
        type: "message_delta",
        delta: {
          secret_future_field: "do not capture",
          stop_reason: "end_turn",
        },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.metadata).toEqual({
      stop_reason: "end_turn",
    });
  });

  it("should extract stop_sequence from message_delta", () => {
    const chunks = [
      {
        type: "message_delta",
        delta: {
          stop_reason: "stop_sequence",
          stop_sequence: "\\n\\n",
        },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.metadata).toEqual({
      stop_reason: "stop_sequence",
      stop_sequence: "\\n\\n",
    });
  });

  it("should handle empty chunks array", () => {
    const result = aggregateAnthropicStreamChunksForTest([]);

    expect(result.output).toBe("");
    // finalizeAnthropicTokens always adds prompt_tokens and tokens
    expect(result.metrics).toEqual({
      prompt_tokens: 0,
      tokens: 0,
    });
    expect(result.metadata).toEqual({});
  });

  it("should ignore non-text deltas", () => {
    const chunks = [
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "content_block_delta",
        delta: { type: "other_delta", data: "ignored" },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: " world" },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toBe("Hello world");
  });

  it("should aggregate streamed tool_use output", () => {
    const chunks = [
      {
        type: "message_start",
        message: {
          role: "assistant",
          usage: {
            input_tokens: 25,
            output_tokens: 0,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"location":"Paris, France"}',
        },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "tool_use",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 12,
        },
      },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: {
            location: "Paris, France",
          },
        },
      ],
    });
    expect(result.metrics).toMatchObject({
      prompt_tokens: 25,
      completion_tokens: 12,
    });
    expect(result.metadata).toEqual({
      stop_reason: "tool_use",
      stop_sequence: null,
    });
  });

  it("should handle chunks without delta or usage", () => {
    const chunks = [
      { type: "message_start" },
      { type: "content_block_start" },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hi" },
      },
      { type: "message_stop" },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toBe("Hi");
  });

  it("should capture thinking content blocks from thinking_delta events", () => {
    const chunks = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " Yes, I understand." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "The answer is 42." },
      },
      { type: "content_block_stop", index: 1 },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toEqual({
      content: [
        { type: "thinking", thinking: "Let me think... Yes, I understand." },
        { type: "text", text: "The answer is 42." },
      ],
    });
  });

  it("should capture citations from citations_delta events and attach to text blocks", () => {
    const citation1 = {
      type: "char_location",
      cited_text: "source text",
      document_index: 0,
      start_char_index: 0,
      end_char_index: 11,
    };
    const chunks = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "According to the document." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "citations_delta", citation: citation1 },
      },
      { type: "content_block_stop", index: 0 },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toEqual({
      content: [
        {
          type: "text",
          text: "According to the document.",
          citations: [citation1],
        },
      ],
    });
  });

  it("should preserve server_tool_use blocks without deltas", () => {
    const chunks = [
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_abc123",
          name: "web_search",
          input: { query: "braintrust" },
        },
      },
      { type: "content_block_stop", index: 0 },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toEqual({
      content: [
        {
          type: "server_tool_use",
          id: "srvtoolu_abc123",
          name: "web_search",
          input: { query: "braintrust" },
        },
      ],
    });
  });

  it("should parse streamed input_json_delta for server_tool_use blocks", () => {
    const chunks = [
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: "srvtoolu_abc123",
          name: "web_search",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"query":"braintrust"',
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: ',"max_uses":1}',
        },
      },
      { type: "content_block_stop", index: 0 },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toEqual({
      content: [
        {
          type: "server_tool_use",
          id: "srvtoolu_abc123",
          name: "web_search",
          input: { query: "braintrust", max_uses: 1 },
        },
      ],
    });
  });

  it("should preserve web_search_tool_result blocks without deltas", () => {
    const chunks = [
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_abc123",
          content: [
            {
              type: "web_search_result",
              url: "https://example.com",
              title: "Example",
            },
          ],
        },
      },
      { type: "content_block_stop", index: 0 },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toEqual({
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_abc123",
          content: [
            {
              type: "web_search_result",
              url: "https://example.com",
              title: "Example",
            },
          ],
        },
      ],
    });
  });

  it("should preserve unknown future content block types", () => {
    const chunks = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "some_future_type", data: "value" },
      },
      { type: "content_block_stop", index: 0 },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toEqual({
      content: [{ type: "some_future_type", data: "value" }],
    });
  });

  it("should handle mixed content: thinking + text + tool_use", () => {
    const chunks = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Reasoning..." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "I'll use a tool." },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "tu_123",
          name: "calc",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"x":' },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "1}" },
      },
      { type: "content_block_stop", index: 2 },
    ];

    const result = aggregateAnthropicStreamChunksForTest(chunks);

    expect(result.output).toEqual({
      content: [
        { type: "thinking", thinking: "Reasoning..." },
        { type: "text", text: "I'll use a tool." },
        { type: "tool_use", id: "tu_123", name: "calc", input: { x: 1 } },
      ],
    });
  });
});

describe("processAttachmentsInInput", () => {
  it("should convert base64 images to Attachment objects", () => {
    // Create a small 1x1 red PNG base64
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const input = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: base64Image,
        },
      },
    ];

    const result = processAttachmentsInInput(input) as any;

    expect(result[0].type).toBe("image");
    expect(result[0].source.type).toBe("base64");
    expect(result[0].source.data).toBeInstanceOf(Attachment);

    const attachment = result[0].source.data as Attachment;
    expect(attachment.reference.filename).toBe("image.png");
    expect(attachment.reference.content_type).toBe("image/png");
  });

  it("should convert base64 documents to Attachment objects", () => {
    const base64Pdf = "JVBERi0xLjQKJeLjz9MK"; // Sample PDF header in base64

    const input = [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64Pdf,
        },
      },
    ];

    const result = processAttachmentsInInput(input) as any;

    expect(result[0].type).toBe("document");
    expect(result[0].source.data).toBeInstanceOf(Attachment);

    const attachment = result[0].source.data as Attachment;
    expect(attachment.reference.filename).toBe("document.pdf");
    expect(attachment.reference.content_type).toBe("application/pdf");
  });

  it("should handle media_type from source", () => {
    const base64Image =
      "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="; // 1x1 GIF

    const input = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/gif",
          data: base64Image,
        },
      },
    ];

    const result = processAttachmentsInInput(input) as any;

    const attachment = result[0].source.data as Attachment;
    expect(attachment.reference.filename).toBe("image.gif");
    expect(attachment.reference.content_type).toBe("image/gif");
  });

  it("should use default media_type for images without media_type", () => {
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const input = [
      {
        type: "image",
        source: {
          type: "base64",
          data: base64Image,
        },
      },
    ];

    const result = processAttachmentsInInput(input) as any;

    const attachment = result[0].source.data as Attachment;
    expect(attachment.reference.filename).toBe("image.png");
    expect(attachment.reference.content_type).toBe("image/png");
  });

  it("should process nested objects recursively", () => {
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const input = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            {
              type: "image",
              source: {
                type: "base64",
                data: base64Image,
              },
            },
          ],
        },
      ],
    };

    const result = processAttachmentsInInput(input) as any;

    expect(result.messages[0].content[0].type).toBe("text");
    expect(result.messages[0].content[1].source.data).toBeInstanceOf(
      Attachment,
    );
  });

  it("should process arrays recursively", () => {
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    const input = [
      { type: "text", text: "Hello" },
      {
        type: "image",
        source: {
          type: "base64",
          data: base64Image,
        },
      },
      { type: "text", text: "World" },
    ];

    const result = processAttachmentsInInput(input) as any;

    expect(result[0]).toEqual({ type: "text", text: "Hello" });
    expect(result[1].source.data).toBeInstanceOf(Attachment);
    expect(result[2]).toEqual({ type: "text", text: "World" });
  });

  it("should pass through non-attachment content", () => {
    const input = [
      { type: "text", text: "Hello world" },
      { type: "custom", data: "some data" },
    ];

    const result = processAttachmentsInInput(input) as any;

    expect(result).toEqual(input);
  });

  it("should pass through primitives unchanged", () => {
    expect(processAttachmentsInInput("string")).toBe("string");
    expect(processAttachmentsInInput(42)).toBe(42);
    expect(processAttachmentsInInput(true)).toBe(true);
    expect(processAttachmentsInInput(null)).toBe(null);
  });

  it("should not process non-base64 image sources", () => {
    const input = [
      {
        type: "image",
        source: {
          type: "url",
          url: "https://example.com/image.png",
        },
      },
    ];

    const result = processAttachmentsInInput(input) as any;

    expect(result).toEqual(input);
  });

  it("should handle missing data in base64 source", () => {
    const input = [
      {
        type: "image",
        source: {
          type: "base64",
          // data is missing
        },
      },
    ];

    const result = processAttachmentsInInput(input) as any;

    // Should not crash, just return as-is or with minimal processing
    expect(result[0].type).toBe("image");
  });

  it("should preserve invalid base64 content when attachment conversion fails", () => {
    const input = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "%%%invalid-base64%%%",
        },
      },
    ];

    expect(processAttachmentsInInput(input)).toEqual(input);
  });
});

describe("coalesceInput", () => {
  it("should place the system message before the conversation messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    const result = coalesceInput(messages, "You are a helpful assistant.");

    expect(result).toEqual([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ]);
  });

  it("should support system content as an array of text blocks", () => {
    const messages = [{ role: "user", content: "Bonjour" }];
    const system = [
      { type: "text" as const, text: "translate to english" },
      { type: "text" as const, text: "only the answer no other text" },
    ];

    const result = coalesceInput(messages, system);

    expect(result[0]).toEqual({ role: "system", content: system });
    expect(result[1]).toEqual({ role: "user", content: "Bonjour" });
  });

  it("should return messages unchanged when there is no system prompt", () => {
    const messages = [{ role: "user", content: "Hello" }];

    expect(coalesceInput(messages, undefined)).toEqual(messages);
  });

  it("should not mutate the original messages array", () => {
    const messages = [{ role: "user", content: "Hello" }];

    coalesceInput(messages, "system prompt");

    expect(messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});
