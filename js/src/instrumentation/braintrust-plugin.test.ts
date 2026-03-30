import { describe, it, expect, vi, beforeEach } from "vitest";
import { BraintrustPlugin } from "./braintrust-plugin";
import { OpenAIPlugin } from "./plugins/openai-plugin";
import { AnthropicPlugin } from "./plugins/anthropic-plugin";
import { AISDKPlugin } from "./plugins/ai-sdk-plugin";
import { ClaudeAgentSDKPlugin } from "./plugins/claude-agent-sdk-plugin";
import { GoogleGenAIPlugin } from "./plugins/google-genai-plugin";
import { OpenRouterPlugin } from "./plugins/openrouter-plugin";

function createPluginClassMock() {
  return vi.fn(function MockPlugin(this: {
    enable: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
  }) {
    this.enable = vi.fn();
    this.disable = vi.fn();
  });
}

// Mock all sub-plugins but preserve the utility functions
vi.mock("./plugins/openai-plugin", async () => {
  const actual = await vi.importActual<
    typeof import("./plugins/openai-plugin")
  >("./plugins/openai-plugin");
  return {
    ...actual,
    OpenAIPlugin: createPluginClassMock(),
  };
});

vi.mock("./plugins/anthropic-plugin", () => ({
  AnthropicPlugin: createPluginClassMock(),
}));

vi.mock("./plugins/ai-sdk-plugin", () => ({
  AISDKPlugin: createPluginClassMock(),
}));

vi.mock("./plugins/claude-agent-sdk-plugin", () => ({
  ClaudeAgentSDKPlugin: createPluginClassMock(),
}));

vi.mock("./plugins/google-genai-plugin", () => ({
  GoogleGenAIPlugin: createPluginClassMock(),
}));

vi.mock("./plugins/openrouter-plugin", () => ({
  OpenRouterPlugin: createPluginClassMock(),
}));

describe("BraintrustPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sub-plugin creation (default behavior)", () => {
    it("should create and enable OpenAI plugin by default", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      const mockInstance = vi.mocked(OpenAIPlugin).mock.results[0].value;
      expect(mockInstance.enable).toHaveBeenCalledTimes(1);
    });

    it("should create and enable Anthropic plugin by default", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      const mockInstance = vi.mocked(AnthropicPlugin).mock.results[0].value;
      expect(mockInstance.enable).toHaveBeenCalledTimes(1);
    });

    it("should create and enable AI SDK plugin by default", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      const mockInstance = vi.mocked(AISDKPlugin).mock.results[0].value;
      expect(mockInstance.enable).toHaveBeenCalledTimes(1);
    });

    it("should create and enable Claude Agent SDK plugin by default", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      const mockInstance =
        vi.mocked(ClaudeAgentSDKPlugin).mock.results[0].value;
      expect(mockInstance.enable).toHaveBeenCalledTimes(1);
    });

    it("should create and enable Google GenAI plugin by default", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      const mockInstance = vi.mocked(GoogleGenAIPlugin).mock.results[0].value;
      expect(mockInstance.enable).toHaveBeenCalledTimes(1);
    });

    it("should create and enable OpenRouter plugin by default", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
      const mockInstance = vi.mocked(OpenRouterPlugin).mock.results[0].value;
      expect(mockInstance.enable).toHaveBeenCalledTimes(1);
    });

    it("should create all plugins when enabled with no config", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });

    it("should create all plugins when enabled with empty config", () => {
      const plugin = new BraintrustPlugin({});
      plugin.enable();

      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });

    it("should create all plugins when enabled with empty integrations config", () => {
      const plugin = new BraintrustPlugin({ integrations: {} });
      plugin.enable();

      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });
  });

  describe("config-based disabling", () => {
    it("should not create OpenAI plugin when openai: false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { openai: false },
      });
      plugin.enable();

      expect(OpenAIPlugin).not.toHaveBeenCalled();
      // Other plugins should still be created
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });

    it("should not create Anthropic plugin when anthropic: false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { anthropic: false },
      });
      plugin.enable();

      expect(AnthropicPlugin).not.toHaveBeenCalled();
      // Other plugins should still be created
      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });

    it("should not create AI SDK plugin when aisdk: false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { aisdk: false },
      });
      plugin.enable();

      expect(AISDKPlugin).not.toHaveBeenCalled();
      // Other plugins should still be created
      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });

    it("should not create Claude Agent SDK plugin when claudeAgentSDK: false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { claudeAgentSDK: false },
      });
      plugin.enable();

      expect(ClaudeAgentSDKPlugin).not.toHaveBeenCalled();
      // Other plugins should still be created
      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });

    it("should not create Google GenAI plugin when googleGenAI: false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { googleGenAI: false },
      });
      plugin.enable();

      expect(GoogleGenAIPlugin).not.toHaveBeenCalled();
      // Other plugins should still be created
      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });

    it("should not create OpenRouter plugin when openrouter: false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { openrouter: false },
      });
      plugin.enable();

      expect(OpenRouterPlugin).not.toHaveBeenCalled();
      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
    });

    it("should not create any plugins when all are disabled", () => {
      const plugin = new BraintrustPlugin({
        integrations: {
          openai: false,
          anthropic: false,
          aisdk: false,
          claudeAgentSDK: false,
          googleGenAI: false,
          openrouter: false,
        },
      });
      plugin.enable();

      expect(OpenAIPlugin).not.toHaveBeenCalled();
      expect(AnthropicPlugin).not.toHaveBeenCalled();
      expect(AISDKPlugin).not.toHaveBeenCalled();
      expect(ClaudeAgentSDKPlugin).not.toHaveBeenCalled();
      expect(GoogleGenAIPlugin).not.toHaveBeenCalled();
      expect(OpenRouterPlugin).not.toHaveBeenCalled();
    });

    it("should allow selective enabling of plugins", () => {
      const plugin = new BraintrustPlugin({
        integrations: {
          openai: true,
          anthropic: false,
          aisdk: false,
          claudeAgentSDK: true,
          googleGenAI: false,
          openrouter: true,
        },
      });
      plugin.enable();

      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).not.toHaveBeenCalled();
      expect(AISDKPlugin).not.toHaveBeenCalled();
      expect(GoogleGenAIPlugin).not.toHaveBeenCalled();
    });
  });

  describe("backward compatibility (legacy config keys)", () => {
    it("should not create AI SDK plugin when vercel: false (legacy)", () => {
      const plugin = new BraintrustPlugin({
        integrations: { vercel: false },
      });
      plugin.enable();

      expect(AISDKPlugin).not.toHaveBeenCalled();
      // Other plugins should still be created
      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
    });

    it("should not create Google GenAI plugin when google: false (legacy)", () => {
      const plugin = new BraintrustPlugin({
        integrations: { google: false },
      });
      plugin.enable();

      expect(GoogleGenAIPlugin).not.toHaveBeenCalled();
      // Other plugins should still be created
      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
    });

    it("should not create AI SDK plugin when both aisdk and vercel are false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { aisdk: false, vercel: false },
      });
      plugin.enable();

      expect(AISDKPlugin).not.toHaveBeenCalled();
    });

    it("should not create Google GenAI plugin when both googleGenAI and google are false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { googleGenAI: false, google: false },
      });
      plugin.enable();

      expect(GoogleGenAIPlugin).not.toHaveBeenCalled();
    });

    it("should not create AI SDK plugin when aisdk is true but vercel is false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { aisdk: true, vercel: false },
      });
      plugin.enable();

      expect(AISDKPlugin).not.toHaveBeenCalled();
    });

    it("should not create Google GenAI plugin when googleGenAI is true but google is false", () => {
      const plugin = new BraintrustPlugin({
        integrations: { googleGenAI: true, google: false },
      });
      plugin.enable();

      expect(GoogleGenAIPlugin).not.toHaveBeenCalled();
    });

    it("should create AI SDK plugin when vercel is true and aisdk is not set", () => {
      const plugin = new BraintrustPlugin({
        integrations: { vercel: true },
      });
      plugin.enable();

      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
    });

    it("should create Google GenAI plugin when google is true and googleGenAI is not set", () => {
      const plugin = new BraintrustPlugin({
        integrations: { google: true },
      });
      plugin.enable();

      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
    });
  });

  describe("enable/disable lifecycle", () => {
    it("should enable all sub-plugins when enabled", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      const openaiMock = vi.mocked(OpenAIPlugin).mock.results[0].value;
      const anthropicMock = vi.mocked(AnthropicPlugin).mock.results[0].value;
      const aiSDKMock = vi.mocked(AISDKPlugin).mock.results[0].value;
      const claudeAgentSDKMock =
        vi.mocked(ClaudeAgentSDKPlugin).mock.results[0].value;
      const googleGenAIMock =
        vi.mocked(GoogleGenAIPlugin).mock.results[0].value;
      const openRouterMock = vi.mocked(OpenRouterPlugin).mock.results[0].value;

      expect(openaiMock.enable).toHaveBeenCalledTimes(1);
      expect(anthropicMock.enable).toHaveBeenCalledTimes(1);
      expect(aiSDKMock.enable).toHaveBeenCalledTimes(1);
      expect(claudeAgentSDKMock.enable).toHaveBeenCalledTimes(1);
      expect(googleGenAIMock.enable).toHaveBeenCalledTimes(1);
      expect(openRouterMock.enable).toHaveBeenCalledTimes(1);
    });

    it("should disable and nullify all sub-plugins when disabled", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      const openaiMock = vi.mocked(OpenAIPlugin).mock.results[0].value;
      const anthropicMock = vi.mocked(AnthropicPlugin).mock.results[0].value;
      const aiSDKMock = vi.mocked(AISDKPlugin).mock.results[0].value;
      const claudeAgentSDKMock =
        vi.mocked(ClaudeAgentSDKPlugin).mock.results[0].value;
      const googleGenAIMock =
        vi.mocked(GoogleGenAIPlugin).mock.results[0].value;
      const openRouterMock = vi.mocked(OpenRouterPlugin).mock.results[0].value;

      plugin.disable();

      expect(openaiMock.disable).toHaveBeenCalledTimes(1);
      expect(anthropicMock.disable).toHaveBeenCalledTimes(1);
      expect(aiSDKMock.disable).toHaveBeenCalledTimes(1);
      expect(claudeAgentSDKMock.disable).toHaveBeenCalledTimes(1);
      expect(googleGenAIMock.disable).toHaveBeenCalledTimes(1);
      expect(openRouterMock.disable).toHaveBeenCalledTimes(1);
    });

    it("should be idempotent on multiple enable calls", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();
      plugin.enable();
      plugin.enable();

      // Should only create and enable plugins once
      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      const mockInstance = vi.mocked(OpenAIPlugin).mock.results[0].value;
      expect(mockInstance.enable).toHaveBeenCalledTimes(1);
    });

    it("should be idempotent on multiple disable calls", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();

      const openaiMock = vi.mocked(OpenAIPlugin).mock.results[0].value;

      plugin.disable();
      plugin.disable();
      plugin.disable();

      // Should only disable plugins once
      expect(openaiMock.disable).toHaveBeenCalledTimes(1);
    });

    it("should not disable plugins if never enabled", () => {
      const plugin = new BraintrustPlugin();
      plugin.disable();

      // Should not create any plugins
      expect(OpenAIPlugin).not.toHaveBeenCalled();
      expect(AnthropicPlugin).not.toHaveBeenCalled();
      expect(AISDKPlugin).not.toHaveBeenCalled();
      expect(ClaudeAgentSDKPlugin).not.toHaveBeenCalled();
      expect(GoogleGenAIPlugin).not.toHaveBeenCalled();
      expect(OpenRouterPlugin).not.toHaveBeenCalled();
    });

    it("should allow re-enabling after disable", () => {
      const plugin = new BraintrustPlugin();
      plugin.enable();
      plugin.disable();

      vi.clearAllMocks();

      plugin.enable();

      expect(OpenAIPlugin).toHaveBeenCalledTimes(1);
      expect(AnthropicPlugin).toHaveBeenCalledTimes(1);
      expect(AISDKPlugin).toHaveBeenCalledTimes(1);
      expect(ClaudeAgentSDKPlugin).toHaveBeenCalledTimes(1);
      expect(GoogleGenAIPlugin).toHaveBeenCalledTimes(1);
      expect(OpenRouterPlugin).toHaveBeenCalledTimes(1);
    });

    it("should only disable plugins that were enabled", () => {
      const plugin = new BraintrustPlugin({
        integrations: {
          openai: true,
          anthropic: false,
          aisdk: true,
          claudeAgentSDK: false,
          googleGenAI: true,
          openrouter: true,
        },
      });
      plugin.enable();

      const openaiMock = vi.mocked(OpenAIPlugin).mock.results[0].value;
      const aiSDKMock = vi.mocked(AISDKPlugin).mock.results[0].value;
      const googleGenAIMock =
        vi.mocked(GoogleGenAIPlugin).mock.results[0].value;
      const openRouterMock = vi.mocked(OpenRouterPlugin).mock.results[0].value;

      plugin.disable();

      expect(openaiMock.disable).toHaveBeenCalledTimes(1);
      expect(aiSDKMock.disable).toHaveBeenCalledTimes(1);
      expect(googleGenAIMock.disable).toHaveBeenCalledTimes(1);
      expect(openRouterMock.disable).toHaveBeenCalledTimes(1);
    });
  });
});

// Re-exported utility function tests from OpenAI plugin
import {
  parseMetricsFromUsage,
  processImagesInOutput,
  aggregateChatCompletionChunks,
} from "./braintrust-plugin";
import { Attachment } from "../logger";

describe("parseMetricsFromUsage", () => {
  it("should return empty object for null usage", () => {
    expect(parseMetricsFromUsage(null)).toEqual({});
  });

  it("should return empty object for undefined usage", () => {
    expect(parseMetricsFromUsage(undefined)).toEqual({});
  });

  it("should parse legacy token names", () => {
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

  it("should parse new API token names and map them", () => {
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

  it("should parse token details fields", () => {
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
      prompt_cached_tokens: 50, // input -> prompt prefix
      prompt_audio_tokens: 10,
      completion_tokens: 80,
      completion_reasoning_tokens: 20, // output -> completion prefix
    });
  });

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

  it("should handle empty usage object", () => {
    expect(parseMetricsFromUsage({})).toEqual({});
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
});

describe("processImagesInOutput", () => {
  it("should convert image_generation_call to attachment", () => {
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

  it("should handle image_generation_call with long revised_prompt", () => {
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

  it("should handle image_generation_call without revised_prompt", () => {
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

  it("should use png as default format", () => {
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

  it("should pass through non-image objects unchanged", () => {
    const output = {
      type: "text",
      content: "Hello world",
    };

    const result = processImagesInOutput(output);
    expect(result).toEqual(output);
  });

  it("should pass through primitive values unchanged", () => {
    expect(processImagesInOutput("string")).toBe("string");
    expect(processImagesInOutput(42)).toBe(42);
    expect(processImagesInOutput(true)).toBe(true);
    expect(processImagesInOutput(null)).toBe(null);
  });

  it("should not process image_generation_call with non-string result", () => {
    const output = {
      type: "image_generation_call",
      result: 12345, // Not a string
    };

    const result = processImagesInOutput(output);
    expect(result).toEqual(output);
    expect(result.result).toBe(12345);
  });
});

describe("aggregateChatCompletionChunks", () => {
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

    const result = aggregateChatCompletionChunks(chunks);

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

  it("should extract role from first chunk", () => {
    const chunks = [
      {
        choices: [{ delta: { role: "assistant" } }],
      },
      {
        choices: [{ delta: { content: "Hi" } }],
      },
    ];

    const result = aggregateChatCompletionChunks(chunks);

    expect(result.output[0].message.role).toBe("assistant");
  });

  it("should extract finish_reason from last chunk with it", () => {
    const chunks = [
      {
        choices: [{ delta: { role: "assistant", content: "Done" } }],
      },
      {
        choices: [{ delta: { finish_reason: "stop" } }],
      },
    ];

    const result = aggregateChatCompletionChunks(chunks);

    expect(result.output[0].finish_reason).toBe("stop");
  });

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

    const result = aggregateChatCompletionChunks(chunks);

    expect(result.output[0].message.tool_calls).toHaveLength(2);
    expect(result.output[0].message.tool_calls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "tool1", arguments: '{"a":1}' },
    });
    expect(result.output[0].message.tool_calls[1]).toEqual({
      id: "call_2",
      type: "function",
      function: { name: "tool2", arguments: '{"b":2}' },
    });
  });

  it("should parse usage metrics from chunks", () => {
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
      tokens: 15, // total_tokens is mapped to tokens
    });
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

  it("should handle chunks without choices", () => {
    const chunks = [
      {},
      { choices: null },
      { choices: [] },
      { choices: [{ delta: { content: "Hi" } }] },
    ];

    const result = aggregateChatCompletionChunks(chunks);

    expect(result.output[0].message.content).toBe("Hi");
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
});
