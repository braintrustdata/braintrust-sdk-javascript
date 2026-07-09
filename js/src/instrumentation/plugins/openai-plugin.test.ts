import { describe, it, expect } from "vitest";
import {
  parseMetricsFromUsage,
  processImagesInOutput,
  aggregateChatCompletionChunks,
} from "./openai-plugin";
import { Attachment } from "../../logger";

describe("parseMetricsFromUsage", () => {
  describe("null/undefined handling", () => {
    it("should return empty object for null usage", () => {
      expect(parseMetricsFromUsage(null)).toEqual({});
    });

    it("should return empty object for undefined usage", () => {
      expect(parseMetricsFromUsage(undefined)).toEqual({});
    });

    it("should handle empty object", () => {
      expect(parseMetricsFromUsage({})).toEqual({});
    });
  });

  describe("legacy token names", () => {
    it("should parse legacy token names (prompt_tokens, completion_tokens, total_tokens)", () => {
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        tokens: 30, // total_tokens is mapped to tokens
      });
    });

    it("should preserve legacy token names as-is", () => {
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 50,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
      });
    });
  });

  describe("new API token names", () => {
    it("should parse new API token names (input_tokens, output_tokens)", () => {
      const usage = {
        input_tokens: 15,
        output_tokens: 25,
        total_tokens: 40,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 15, // input_tokens mapped to prompt_tokens
        completion_tokens: 25, // output_tokens mapped to completion_tokens
        tokens: 40, // total_tokens mapped to tokens
      });
    });

    it("should map input_tokens to prompt_tokens", () => {
      const usage = {
        input_tokens: 100,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 100,
      });
    });

    it("should map output_tokens to completion_tokens", () => {
      const usage = {
        output_tokens: 50,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        completion_tokens: 50,
      });
    });
  });

  describe("token details fields", () => {
    it("should parse input_tokens_details.cached_tokens -> prompt_cached_tokens", () => {
      const usage = {
        input_tokens: 100,
        input_tokens_details: {
          cached_tokens: 50,
        },
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 100,
        prompt_cached_tokens: 50, // input -> prompt prefix
      });
    });

    it("should parse output_tokens_details.reasoning_tokens -> completion_reasoning_tokens", () => {
      const usage = {
        output_tokens: 80,
        output_tokens_details: {
          reasoning_tokens: 20,
        },
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        completion_tokens: 80,
        completion_reasoning_tokens: 20, // output -> completion prefix
      });
    });

    it("should parse all token details fields", () => {
      const usage = {
        input_tokens: 100,
        input_tokens_details: {
          cached_tokens: 50,
          audio_tokens: 10,
        },
        output_tokens: 80,
        output_tokens_details: {
          reasoning_tokens: 20,
        },
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 100,
        prompt_cached_tokens: 50,
        prompt_audio_tokens: 10,
        completion_tokens: 80,
        completion_reasoning_tokens: 20,
      });
    });

    it("should handle unknown token prefix in details", () => {
      const usage = {
        custom_tokens: 100,
        custom_tokens_details: {
          special: 25,
        },
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        custom_tokens: 100,
        custom_special: 25, // custom prefix preserved
      });
    });

    it("should ignore non-object token details", () => {
      const usage = {
        input_tokens: 100,
        input_tokens_details: "not an object",
        output_tokens: 80,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 100,
        completion_tokens: 80,
      });
    });

    it("should ignore non-number values in token details", () => {
      const usage = {
        input_tokens: 100,
        input_tokens_details: {
          cached_tokens: 50,
          invalid: "not a number",
          also_invalid: null,
        },
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 100,
        prompt_cached_tokens: 50,
      });
    });
  });

  describe("mixed legacy + new format", () => {
    it("should handle mixed legacy and new token names", () => {
      const usage = {
        prompt_tokens: 10,
        input_tokens: 15,
        completion_tokens: 20,
        total_tokens: 30,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 15, // Last one wins (input_tokens mapped)
        completion_tokens: 20,
        tokens: 30, // total_tokens is mapped to tokens
      });
    });

    it("should handle new format with details and legacy format", () => {
      const usage = {
        prompt_tokens: 100,
        input_tokens: 110,
        input_tokens_details: {
          cached_tokens: 30,
        },
        completion_tokens: 50,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        prompt_tokens: 110, // input_tokens wins
        prompt_cached_tokens: 30,
        completion_tokens: 50,
      });
    });
  });

  describe("invalid values", () => {
    it("should ignore non-number token values", () => {
      const usage = {
        prompt_tokens: "not a number",
        completion_tokens: 20,
        total_tokens: null,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        completion_tokens: 20,
      });
    });

    it("should ignore string token values", () => {
      const usage = {
        input_tokens: "100",
        output_tokens: 50,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        completion_tokens: 50,
      });
    });

    it("should ignore boolean token values", () => {
      const usage = {
        input_tokens: true,
        output_tokens: 50,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        completion_tokens: 50,
      });
    });

    it("should ignore array token values", () => {
      const usage = {
        input_tokens: [100],
        output_tokens: 50,
      };

      const result = parseMetricsFromUsage(usage);

      expect(result).toEqual({
        completion_tokens: 50,
      });
    });
  });
});

describe("aggregateChatCompletionChunks", () => {
  describe("basic aggregation", () => {
    it("should aggregate simple text chunks", () => {
      const chunks = [
        {
          choices: [{ delta: { role: "assistant", content: "Hello" } }],
        },
        {
          choices: [{ delta: { content: " world" } }],
        },
        {
          choices: [{ delta: { content: "!" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);

      expect(result.output).toEqual([
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello world!",
            tool_calls: undefined,
          },
          logprobs: null,
          finish_reason: undefined,
        },
      ]);
      expect(result.metrics).toEqual({});
    });

    it("should handle empty chunks array", () => {
      const result = aggregateChatCompletionChunks([]);

      expect(result.output).toEqual([
        {
          index: 0,
          message: {
            role: undefined,
            content: undefined,
            tool_calls: undefined,
          },
          logprobs: null,
          finish_reason: undefined,
        },
      ]);
      expect(result.metrics).toEqual({});
    });
  });

  describe("role extraction", () => {
    it("should extract role from first chunk", () => {
      const chunks = [
        {
          choices: [{ delta: { role: "assistant" } }],
        },
        {
          choices: [{ delta: { content: "Hi" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);

      expect(result.output[0].message.role).toBe("assistant");
    });

    it("should only use role from first chunk with role", () => {
      const chunks = [
        {
          choices: [{ delta: { content: "Hi" } }],
        },
        {
          choices: [{ delta: { role: "assistant" } }],
        },
        {
          choices: [{ delta: { role: "user" } }], // Should be ignored
        },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);

      expect(result.output[0].message.role).toBe("assistant");
    });
  });

  describe("content concatenation", () => {
    it("should concatenate content across chunks", () => {
      const chunks = [
        {
          choices: [{ delta: { content: "Hello" } }],
        },
        {
          choices: [{ delta: { content: " " } }],
        },
        {
          choices: [{ delta: { content: "world" } }],
        },
        {
          choices: [{ delta: { content: "!" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);

      expect(result.output[0].message.content).toBe("Hello world!");
    });

    it("should handle chunks with empty content", () => {
      const chunks = [
        {
          choices: [{ delta: { content: "Hello" } }],
        },
        {
          choices: [{ delta: { content: "" } }],
        },
        {
          choices: [{ delta: { content: "!" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.output[0].message.content).toBe("Hello!");
    });

    it("should handle undefined content in chunks", () => {
      const chunks = [
        {
          choices: [{ delta: { content: "Hello" } }],
        },
        {
          choices: [{ delta: {} }],
        },
        {
          choices: [{ delta: { content: "!" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.output[0].message.content).toBe("Hello!");
    });
  });

  describe("tool calls aggregation", () => {
    it("should aggregate tool calls by id", () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"loc' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: { arguments: 'ation":"' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: { arguments: 'NYC"}' },
                  },
                ],
              },
            },
          ],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.output[0].message.tool_calls).toEqual([
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"location":"NYC"}' },
        },
      ]);
    });

    it("should handle multiple tool calls", () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "tool1", arguments: '{"a":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: { arguments: "1}" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_2",
                    type: "function",
                    function: { name: "tool2", arguments: '{"b":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: { arguments: "2}" },
                  },
                ],
              },
            },
          ],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);
      const output = result.output as any[];

      expect(output[0].message.tool_calls).toHaveLength(2);
      expect(output[0].message.tool_calls[0]).toEqual({
        id: "call_1",
        type: "function",
        function: { name: "tool1", arguments: '{"a":1}' },
      });
      expect(output[0].message.tool_calls[1]).toEqual({
        id: "call_2",
        type: "function",
        function: { name: "tool2", arguments: '{"b":2}' },
      });
    });

    it("should handle tool calls without initial id", () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "tool", arguments: '{"a":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: { arguments: "1}" },
                  },
                ],
              },
            },
          ],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);
      const output = result.output as any[];

      expect(output[0].message.tool_calls).toHaveLength(1);
      expect(output[0].message.tool_calls[0].function.arguments).toBe(
        '{"a":1}',
      );
    });
  });

  describe("finish reason", () => {
    it("should extract finish_reason from last chunk with it", () => {
      const chunks = [
        {
          choices: [{ delta: { role: "assistant", content: "Done" } }],
        },
        {
          choices: [{ delta: { finish_reason: "stop" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);

      expect(result.output[0].finish_reason).toBe("stop");
    });

    it("should use latest finish_reason when multiple chunks have it", () => {
      const chunks = [
        {
          choices: [{ delta: { finish_reason: "length" } }],
        },
        {
          choices: [{ delta: { finish_reason: "stop" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.output[0].finish_reason).toBe("stop");
    });

    it("should handle tool_calls finish_reason", () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                content: "Let me check",
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "check", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { finish_reason: "tool_calls" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.output[0].finish_reason).toBe("tool_calls");
    });
  });

  describe("usage metrics", () => {
    it("should parse usage metrics from chunk with usage field", () => {
      const chunks = [
        {
          choices: [{ delta: { role: "assistant", content: "Hi" } }],
        },
        {
          choices: [{ delta: { content: "!" } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        tokens: 12, // total_tokens is mapped to tokens
      });
    });

    it("should merge usage from multiple chunks", () => {
      const chunks = [
        {
          choices: [{ delta: { role: "assistant" } }],
          usage: {
            prompt_tokens: 10,
          },
        },
        {
          choices: [{ delta: { content: "Hi" } }],
          usage: {
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        tokens: 15,
      });
    });

    it("should handle chunks with only usage", () => {
      const chunks = [
        {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
          },
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
      });
    });

    it("should handle new API token format in usage", () => {
      const chunks = [
        {
          choices: [{ delta: { content: "Hi" } }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: {
              cached_tokens: 20,
            },
          },
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.metrics).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cached_tokens: 20,
      });
    });
  });

  describe("edge cases", () => {
    it("should handle chunks without choices", () => {
      const chunks = [
        {},
        { choices: null },
        { choices: [] },
        { choices: [{ delta: { content: "Hi" } }] },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);

      expect(result.output[0].message.content).toBe("Hi");
    });

    it("should handle chunks with null delta", () => {
      const chunks = [
        { choices: [{ delta: null }] },
        { choices: [{ delta: { content: "Hi" } }] },
      ];

      const result = aggregateChatCompletionChunks(chunks as any);

      expect(result.output[0].message.content).toBe("Hi");
    });

    it("should handle mixed content and tool calls", () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                content: "Let me check",
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "check", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { finish_reason: "tool_calls" } }],
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.output[0].message.content).toBe("Let me check");
      expect(result.output[0].message.tool_calls).toHaveLength(1);
      expect(result.output[0].finish_reason).toBe("tool_calls");
    });

    it("should handle all fields in single chunk", () => {
      const chunks = [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                content: "Done",
                finish_reason: "stop",
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        },
      ];

      const result = aggregateChatCompletionChunks(chunks);

      expect(result.output[0]).toEqual({
        index: 0,
        message: {
          role: "assistant",
          content: "Done",
          tool_calls: undefined,
        },
        logprobs: null,
        finish_reason: "stop",
      });
      expect(result.metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        tokens: 12,
      });
    });
  });
});

describe("processImagesInOutput", () => {
  describe("image_generation_call conversion", () => {
    it("should convert image_generation_call type to Attachment", () => {
      // Create a small 1x1 red PNG base64
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        output_format: "png",
        revised_prompt: "A red pixel",
      };

      const result = processImagesInOutput(output);

      expect(result.type).toBe("image_generation_call");
      expect(result.output_format).toBe("png");
      expect(result.revised_prompt).toBe("A red pixel");
      expect(result.result).toBeInstanceOf(Attachment);

      const attachment = result.result as Attachment;
      expect(attachment.reference.filename).toContain(".png");
      expect(attachment.reference.content_type).toBe("image/png");
    });

    it("should handle different image formats (jpg)", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        output_format: "jpg",
      };

      const result = processImagesInOutput(output);

      const attachment = result.result as Attachment;
      expect(attachment.reference.filename).toBe("generated_image.jpg");
      expect(attachment.reference.content_type).toBe("image/jpg");
    });

    it("should handle different image formats (webp)", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        output_format: "webp",
      };

      const result = processImagesInOutput(output);

      const attachment = result.result as Attachment;
      expect(attachment.reference.filename).toBe("generated_image.webp");
      expect(attachment.reference.content_type).toBe("image/webp");
    });

    it("should use png as default format when output_format is missing", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
      };

      const result = processImagesInOutput(output);

      const attachment = result.result as Attachment;
      expect(attachment.reference.filename).toBe("generated_image.png");
      expect(attachment.reference.content_type).toBe("image/png");
    });

    it("should handle revised_prompt for filename generation", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        revised_prompt: "A beautiful sunset",
      };

      const result = processImagesInOutput(output);

      const attachment = result.result as Attachment;
      expect(attachment.reference.filename).toContain("A_beautiful_sunset");
      expect(attachment.reference.filename).toContain(".png");
    });

    it("should truncate long revised_prompt to 50 characters", () => {
      const longPrompt =
        "This is a very long prompt that should be truncated to 50 characters when used as filename";
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        revised_prompt: longPrompt,
      };

      const result = processImagesInOutput(output);

      const attachment = result.result as Attachment;
      // Should be truncated to 50 chars + sanitized + extension
      expect(attachment.reference.filename.length).toBeLessThanOrEqual(54); // 50 + ".png"
    });

    it("should sanitize non-alphanumeric characters in revised_prompt", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        revised_prompt: "Hello@World#Test!",
      };

      const result = processImagesInOutput(output);

      const attachment = result.result as Attachment;
      expect(attachment.reference.filename).toBe("Hello_World_Test_.png");
    });

    it("should use generated_image as default filename when revised_prompt is missing", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        output_format: "jpg",
      };

      const result = processImagesInOutput(output);

      const attachment = result.result as Attachment;
      expect(attachment.reference.filename).toBe("generated_image.jpg");
    });

    it("should preserve other properties of image_generation_call", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        output_format: "png",
        revised_prompt: "Test",
        custom_field: "custom_value",
        another_field: 123,
      };

      const result = processImagesInOutput(output);

      expect(result.type).toBe("image_generation_call");
      expect(result.output_format).toBe("png");
      expect(result.revised_prompt).toBe("Test");
      expect(result.custom_field).toBe("custom_value");
      expect(result.another_field).toBe(123);
    });
  });

  describe("recursive array processing", () => {
    it("should process arrays recursively", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = [
        { type: "text", content: "Hello" },
        {
          type: "image_generation_call",
          result: base64Image,
        },
        { type: "text", content: "World" },
      ];

      const result = processImagesInOutput(output);

      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toEqual({ type: "text", content: "Hello" });
      expect(result[1].result).toBeInstanceOf(Attachment);
      expect(result[2]).toEqual({ type: "text", content: "World" });
    });

    it("should process nested arrays", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = [
        [
          {
            type: "image_generation_call",
            result: base64Image,
          },
        ],
      ];

      const result = processImagesInOutput(output);

      expect(Array.isArray(result)).toBe(true);
      expect(Array.isArray(result[0])).toBe(true);
      expect(result[0][0].result).toBeInstanceOf(Attachment);
    });

    it("should process multiple images in array", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = [
        {
          type: "image_generation_call",
          result: base64Image,
          revised_prompt: "Image 1",
        },
        {
          type: "image_generation_call",
          result: base64Image,
          revised_prompt: "Image 2",
        },
      ];

      const result = processImagesInOutput(output);

      expect(result[0].result).toBeInstanceOf(Attachment);
      expect(result[1].result).toBeInstanceOf(Attachment);
      expect(result[0].result.reference.filename).toContain("Image_1");
      expect(result[1].result.reference.filename).toContain("Image_2");
    });

    it("should handle empty arrays", () => {
      const result = processImagesInOutput([]);

      expect(result).toEqual([]);
    });
  });

  describe("non-image output passthrough", () => {
    it("should pass through non-image objects unchanged", () => {
      const output = {
        type: "text",
        content: "Hello world",
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
    });

    it("should pass through objects without type field", () => {
      const output = {
        content: "Hello world",
        data: "some data",
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
    });

    it("should pass through objects with different type", () => {
      const output = {
        type: "completion",
        content: "Generated text",
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
    });

    it("should pass through primitive string values", () => {
      expect(processImagesInOutput("string")).toBe("string");
    });

    it("should pass through primitive number values", () => {
      expect(processImagesInOutput(42)).toBe(42);
    });

    it("should pass through primitive boolean values", () => {
      expect(processImagesInOutput(true)).toBe(true);
      expect(processImagesInOutput(false)).toBe(false);
    });
  });

  describe("null/undefined handling", () => {
    it("should pass through null unchanged", () => {
      expect(processImagesInOutput(null)).toBe(null);
    });

    it("should pass through undefined unchanged", () => {
      expect(processImagesInOutput(undefined)).toBe(undefined);
    });

    it("should handle object with null result", () => {
      const output = {
        type: "image_generation_call",
        result: null,
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
    });

    it("should handle object with undefined result", () => {
      const output = {
        type: "image_generation_call",
        result: undefined,
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
    });
  });

  describe("invalid image_generation_call handling", () => {
    it("should not process image_generation_call with non-string result", () => {
      const output = {
        type: "image_generation_call",
        result: 12345, // Not a string
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
      expect(result.result).toBe(12345);
    });

    it("should not process image_generation_call with object result", () => {
      const output = {
        type: "image_generation_call",
        result: { data: "some data" },
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
    });

    it("should not process image_generation_call with array result", () => {
      const output = {
        type: "image_generation_call",
        result: ["data"],
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
    });

    it("should not process image_generation_call with boolean result", () => {
      const output = {
        type: "image_generation_call",
        result: true,
      };

      const result = processImagesInOutput(output);
      expect(result).toEqual(output);
    });

    it("should handle non-string revised_prompt gracefully", () => {
      const base64Image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

      const output = {
        type: "image_generation_call",
        result: base64Image,
        revised_prompt: 12345, // Not a string
      };

      const result = processImagesInOutput(output);

      const attachment = result.result as Attachment;
      expect(attachment.reference.filename).toBe("generated_image.png");
    });
  });
});
