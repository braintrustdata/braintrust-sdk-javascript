import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

import {
  AnthropicPlugin,
  parseMetricsFromUsage,
  aggregateAnthropicStreamChunks,
  processAttachmentsInInput,
} from "./anthropic-plugin";
import type { StartEvent } from "../core";
import { Attachment } from "../../logger";
import iso from "../../isomorph";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

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

describe("AnthropicPlugin", () => {
  let plugin: AnthropicPlugin;
  let mockChannel: any;
  let mockHandlers: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create a mock channel that captures the handlers
    mockChannel = {
      subscribe: vi.fn((handlers: any) => {
        mockHandlers = handlers;
      }),
      unsubscribe: vi.fn(),
      hasSubscribers: false,
    };

    mockNewTracingChannel.mockReturnValue(mockChannel);

    plugin = new AnthropicPlugin();
  });

  afterEach(() => {
    if (plugin) {
      plugin.disable();
    }
  });

  describe("enable/disable", () => {
    it("should subscribe to channels when enabled", () => {
      plugin.enable();

      // Should subscribe to both messages.create and beta.messages.create
      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@anthropic-ai/sdk:messages.create",
      );
      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@anthropic-ai/sdk:beta.messages.create",
      );
      expect(mockChannel.subscribe).toHaveBeenCalled();
    });

    it("should unsubscribe from channels when disabled", () => {
      plugin.enable();
      plugin.disable();

      expect(mockChannel.unsubscribe).toHaveBeenCalled();
    });

    it("should handle multiple enable/disable cycles", () => {
      plugin.enable();
      plugin.disable();
      plugin.enable();
      plugin.disable();

      // Should have subscribed twice (7 channels × 2 enables)
      expect(mockChannel.subscribe).toHaveBeenCalledTimes(14); // 7 channels × 2 enables
    });
  });
});

describe("parseMetricsFromUsage", () => {
  it("should return empty object for null usage", () => {
    expect(parseMetricsFromUsage(null)).toEqual({});
  });

  it("should return empty object for undefined usage", () => {
    expect(parseMetricsFromUsage(undefined)).toEqual({});
  });

  it("should map Anthropic token names to Braintrust names", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
    };

    const result = parseMetricsFromUsage(usage);

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

    const result = parseMetricsFromUsage(usage);

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

    const result = parseMetricsFromUsage(usage);

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

    const result = parseMetricsFromUsage(usage);

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_cached_tokens: 25,
      prompt_cache_creation_tokens: 30,
    });
  });

  it("should ignore non-number token values", () => {
    const usage = {
      input_tokens: "not a number",
      output_tokens: 50,
      cache_read_input_tokens: null,
    };

    const result = parseMetricsFromUsage(usage);

    expect(result).toEqual({
      completion_tokens: 50,
    });
  });

  it("should handle empty usage object", () => {
    expect(parseMetricsFromUsage({})).toEqual({});
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

    const result = aggregateAnthropicStreamChunks(chunks);

    expect(result.output).toBe("Hello world");
    expect(result.metrics).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
    });
  });

  it("should extract initial usage from message_start", () => {
    const chunks = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 50,
          },
        },
      },
    ];

    const result = aggregateAnthropicStreamChunks(chunks);

    // finalizeAnthropicTokens adds all cache tokens to prompt_tokens
    expect(result.metrics).toMatchObject({
      prompt_tokens: 150, // 100 + 50
      prompt_cached_tokens: 50,
      tokens: 150, // prompt_tokens + completion_tokens (0)
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

    const result = aggregateAnthropicStreamChunks(chunks);

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

    const result = aggregateAnthropicStreamChunks(chunks);

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
          stop_reason: "end_turn",
        },
      },
    ];

    const result = aggregateAnthropicStreamChunks(chunks);

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

    const result = aggregateAnthropicStreamChunks(chunks);

    expect(result.metadata).toEqual({
      stop_reason: "stop_sequence",
      stop_sequence: "\\n\\n",
    });
  });

  it("should handle empty chunks array", () => {
    const result = aggregateAnthropicStreamChunks([]);

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

    const result = aggregateAnthropicStreamChunks(chunks);

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

    const result = aggregateAnthropicStreamChunks(chunks);

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

    const result = aggregateAnthropicStreamChunks(chunks);

    expect(result.output).toBe("Hi");
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

    const result = processAttachmentsInInput(input);

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

    const result = processAttachmentsInInput(input);

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

    const result = processAttachmentsInInput(input);

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

    const result = processAttachmentsInInput(input);

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

    const result = processAttachmentsInInput(input);

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

    const result = processAttachmentsInInput(input);

    expect(result[0]).toEqual({ type: "text", text: "Hello" });
    expect(result[1].source.data).toBeInstanceOf(Attachment);
    expect(result[2]).toEqual({ type: "text", text: "World" });
  });

  it("should pass through non-attachment content", () => {
    const input = [
      { type: "text", text: "Hello world" },
      { type: "custom", data: "some data" },
    ];

    const result = processAttachmentsInInput(input);

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

    const result = processAttachmentsInInput(input);

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

    const result = processAttachmentsInInput(input);

    // Should not crash, just return as-is or with minimal processing
    expect(result[0].type).toBe("image");
  });
});
