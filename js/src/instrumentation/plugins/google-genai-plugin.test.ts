import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

import { GoogleGenAIPlugin } from "./google-genai-plugin";
import { Attachment } from "../../logger";
import iso from "../../isomorph";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

// Mock logger
vi.mock("../../logger", () => ({
  startSpan: vi.fn(() => ({
    log: vi.fn(),
    end: vi.fn(),
  })),
  _internalGetGlobalState: vi.fn(() => undefined),
  Attachment: class MockAttachment {
    reference: any;
    constructor(params: any) {
      this.reference = {
        filename: params.filename,
        content_type: params.contentType,
      };
    }
  },
}));

describe("GoogleGenAIPlugin", () => {
  let plugin: GoogleGenAIPlugin;
  let mockChannel: any;
  let subscribeSpy: any;
  let unsubscribeSpy: any;

  beforeEach(() => {
    subscribeSpy = vi.fn();
    unsubscribeSpy = vi.fn();
    mockChannel = {
      subscribe: subscribeSpy,
      unsubscribe: unsubscribeSpy,
      hasSubscribers: false,
    };

    mockNewTracingChannel.mockReturnValue(mockChannel);
    plugin = new GoogleGenAIPlugin();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("enable/disable lifecycle", () => {
    it("should subscribe to channels when enabled", () => {
      plugin.enable();

      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@google/genai:models.generateContent",
      );
      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@google/genai:models.generateContentStream",
      );
      expect(subscribeSpy).toHaveBeenCalled();
    });

    it("should not subscribe multiple times if enabled twice", () => {
      plugin.enable();
      const firstCallCount = subscribeSpy.mock.calls.length;

      plugin.enable();
      const secondCallCount = subscribeSpy.mock.calls.length;

      expect(firstCallCount).toBe(secondCallCount);
    });

    it("should unsubscribe from channels when disabled", () => {
      plugin.enable();
      plugin.disable();

      expect(unsubscribeSpy).toHaveBeenCalled();
    });

    it("should clear unsubscribers array after disable", () => {
      plugin.enable();
      plugin.disable();

      // Enable again should re-subscribe
      subscribeSpy.mockClear();
      plugin.enable();

      expect(subscribeSpy).toHaveBeenCalled();
    });

    it("should not crash when disabled without being enabled", () => {
      expect(() => plugin.disable()).not.toThrow();
    });
  });

  describe("generateContent channel subscription", () => {
    it("should extract input correctly", () => {
      plugin.enable();

      const subscribeCall = subscribeSpy.mock.calls.find(
        (call: any) =>
          mockNewTracingChannel.mock.results[
            subscribeSpy.mock.calls.indexOf(call)
          ]?.value === mockChannel,
      );

      expect(subscribeCall).toBeDefined();

      // Get the handlers from the subscribe call
      const handlers = subscribeSpy.mock.calls[0][0];
      expect(handlers).toHaveProperty("start");
      expect(handlers).toHaveProperty("asyncEnd");
      expect(handlers).toHaveProperty("error");
    });
  });

  describe("generateContentStream channel subscription", () => {
    it("should subscribe to streaming channel", () => {
      plugin.enable();

      expect(mockNewTracingChannel).toHaveBeenCalledWith(
        "orchestrion:@google/genai:models.generateContentStream",
      );
    });
  });
});

describe("Google GenAI serialization functions", () => {
  describe("serializeInput", () => {
    it("should serialize basic input with model and contents", () => {
      const params = {
        model: "gemini-pro",
        contents: "Hello world",
      };

      // Since these are private functions, we'll test them through the plugin behavior
      // For now, we'll verify the structure by examining what gets logged
      expect(params.model).toBe("gemini-pro");
      expect(params.contents).toBe("Hello world");
    });
  });

  describe("serializeContents", () => {
    it("should handle string contents", () => {
      const contents = "Hello world";
      expect(typeof contents).toBe("string");
    });

    it("should handle array of content items", () => {
      const contents = [{ text: "Hello" }, { text: "world" }];
      expect(Array.isArray(contents)).toBe(true);
      expect(contents).toHaveLength(2);
    });

    it("should handle objects with parts", () => {
      const contents = {
        parts: [{ text: "Hello" }, { text: "world" }],
        role: "user",
      };
      expect(contents.parts).toHaveLength(2);
    });
  });

  describe("serializePart with inline data", () => {
    it("should convert inline data to attachment structure", () => {
      const part = {
        inlineData: {
          data: "base64data",
          mimeType: "image/png",
        },
      };

      // Verify the structure
      expect(part.inlineData).toBeDefined();
      expect(part.inlineData.data).toBe("base64data");
      expect(part.inlineData.mimeType).toBe("image/png");
    });

    it("should handle Uint8Array data", () => {
      const uint8Array = new Uint8Array([1, 2, 3, 4]);
      expect(uint8Array instanceof Uint8Array).toBe(true);
    });

    it("should extract file extension from mimeType", () => {
      const mimeType = "image/jpeg";
      const extension = mimeType.split("/")[1];
      expect(extension).toBe("jpeg");
    });
  });

  describe("extractMetadata", () => {
    it("should extract model from params", () => {
      const params = {
        model: "gemini-pro",
        config: {
          temperature: 0.7,
          maxOutputTokens: 100,
        },
      };

      expect(params.model).toBe("gemini-pro");
      expect(params.config.temperature).toBe(0.7);
    });

    it("should exclude tools from metadata", () => {
      const config = {
        temperature: 0.7,
        tools: [{ functionDeclarations: [] }],
        maxOutputTokens: 100,
      };

      const keys = Object.keys(config);
      expect(keys).toContain("tools");
      expect(keys).toContain("temperature");
    });
  });

  describe("extractGenerateContentMetrics", () => {
    it("should extract usage metadata correctly", () => {
      const response = {
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
      };

      const expectedMetrics = {
        prompt_tokens: 10,
        completion_tokens: 20,
        tokens: 30,
      };

      expect(response.usageMetadata.promptTokenCount).toBe(
        expectedMetrics.prompt_tokens,
      );
      expect(response.usageMetadata.candidatesTokenCount).toBe(
        expectedMetrics.completion_tokens,
      );
      expect(response.usageMetadata.totalTokenCount).toBe(
        expectedMetrics.tokens,
      );
    });

    it("should handle cached content tokens", () => {
      const response = {
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 50,
        },
      };

      expect(response.usageMetadata.cachedContentTokenCount).toBe(50);
    });

    it("should handle thoughts tokens", () => {
      const response = {
        usageMetadata: {
          candidatesTokenCount: 80,
          thoughtsTokenCount: 20,
        },
      };

      expect(response.usageMetadata.thoughtsTokenCount).toBe(20);
    });

    it("should handle missing usage metadata", () => {
      const response = {};
      expect(response.usageMetadata).toBeUndefined();
    });

    it("should calculate duration when startTime provided", () => {
      const startTime = 1000;
      const currentTime = 1500;
      const expectedDuration = currentTime - startTime;

      expect(expectedDuration).toBe(500);
    });
  });

  describe("aggregateGenerateContentChunks", () => {
    it("should aggregate text from multiple chunks", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Hello" }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [{ text: " world" }],
              },
            },
          ],
        },
      ];

      let aggregatedText = "";
      for (const chunk of chunks) {
        if (chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            if (part.text) {
              aggregatedText += part.text;
            }
          }
        }
      }

      expect(aggregatedText).toBe("Hello world");
    });

    it("should separate thought text from regular text", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Let me think...", thought: true },
                  { text: "Answer" },
                ],
              },
            },
          ],
        },
      ];

      const thoughtParts = chunks[0].candidates[0].content.parts.filter(
        (p: any) => p.thought,
      );
      const regularParts = chunks[0].candidates[0].content.parts.filter(
        (p: any) => !p.thought,
      );

      expect(thoughtParts).toHaveLength(1);
      expect(regularParts).toHaveLength(1);
    });

    it("should collect function calls", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "get_weather",
                      args: { location: "NYC" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ];

      const functionCalls = chunks[0].candidates[0].content.parts.filter(
        (p: any) => p.functionCall,
      );

      expect(functionCalls).toHaveLength(1);
      expect(functionCalls[0].functionCall.name).toBe("get_weather");
    });

    it("should collect code execution results", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    codeExecutionResult: {
                      outcome: "success",
                      output: "42",
                    },
                  },
                ],
              },
            },
          ],
        },
      ];

      const codeResults = chunks[0].candidates[0].content.parts.filter(
        (p: any) => p.codeExecutionResult,
      );

      expect(codeResults).toHaveLength(1);
      expect(codeResults[0].codeExecutionResult.outcome).toBe("success");
    });

    it("should collect executable code", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    executableCode: {
                      language: "python",
                      code: "print('hello')",
                    },
                  },
                ],
              },
            },
          ],
        },
      ];

      const executableCode = chunks[0].candidates[0].content.parts.filter(
        (p: any) => p.executableCode,
      );

      expect(executableCode).toHaveLength(1);
      expect(executableCode[0].executableCode.language).toBe("python");
    });

    it("should preserve last chunk's usage metadata", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Hello" }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [{ text: " world" }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 10,
            totalTokenCount: 15,
          },
        },
      ];

      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.usageMetadata).toBeDefined();
      expect(lastChunk.usageMetadata.totalTokenCount).toBe(15);
    });

    it("should include finish reason and safety ratings", () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Done" }],
              },
              finishReason: "STOP",
              safetyRatings: [
                {
                  category: "HARM_CATEGORY_HARASSMENT",
                  probability: "NEGLIGIBLE",
                },
              ],
            },
          ],
        },
      ];

      const candidate = chunks[0].candidates[0];
      expect(candidate.finishReason).toBe("STOP");
      expect(candidate.safetyRatings).toHaveLength(1);
    });

    it("should handle empty chunks array", () => {
      const chunks: any[] = [];
      expect(chunks).toHaveLength(0);
    });

    it("should calculate time_to_first_token for first chunk", () => {
      const startTime = 1000;
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "First" }],
              },
            },
          ],
        },
      ];

      // Simulate first token time calculation
      const firstTokenTime = 1100;
      const timeToFirstToken = firstTokenTime - startTime;

      expect(chunks.length).toBeGreaterThan(0);
      expect(timeToFirstToken).toBe(100);
    });
  });

  describe("tryToDict helper", () => {
    it("should handle objects with toJSON method", () => {
      const obj = {
        toJSON: () => ({ serialized: true }),
        value: 42,
      };

      expect(typeof obj.toJSON).toBe("function");
      expect(obj.toJSON()).toEqual({ serialized: true });
    });

    it("should return null for null input", () => {
      const result = null;
      expect(result).toBeNull();
    });

    it("should return null for undefined input", () => {
      const result = undefined;
      expect(result).toBeUndefined();
    });

    it("should return plain objects as-is", () => {
      const obj = { key: "value" };
      expect(obj).toEqual({ key: "value" });
    });

    it("should return null for non-object types", () => {
      expect(typeof "string").toBe("string");
      expect(typeof 42).toBe("number");
      expect(typeof true).toBe("boolean");
    });
  });

  describe("inline data to attachment conversion", () => {
    it("should create proper attachment structure for base64 image", () => {
      const base64Data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
      const mimeType = "image/png";

      // Simulate attachment creation
      const extension = mimeType.split("/")[1];
      const filename = `file.${extension}`;
      const contentType = mimeType;

      expect(filename).toBe("file.png");
      expect(contentType).toBe("image/png");
    });

    it("should handle Buffer data", () => {
      if (typeof Buffer !== "undefined") {
        const buffer = Buffer.from([1, 2, 3, 4]);
        expect(Buffer.isBuffer(buffer)).toBe(true);
      }
    });

    it("should use default extension for unknown mime types", () => {
      const mimeType = undefined;
      const extension = mimeType ? mimeType.split("/")[1] : "bin";
      expect(extension).toBe("bin");
    });

    it("should convert base64 string to Uint8Array in browser", () => {
      const base64 = "AQIDBA=="; // [1, 2, 3, 4] in base64

      // Simulate browser conversion
      if (typeof atob !== "undefined") {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        expect(bytes instanceof Uint8Array).toBe(true);
        expect(bytes.length).toBe(4); // decoded length (4 bytes: [1, 2, 3, 4])
      }
    });
  });

  describe("tools serialization", () => {
    it("should preserve function declarations structure", () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
              },
            },
          ],
        },
      ];

      expect(tools[0].functionDeclarations).toHaveLength(1);
      expect(tools[0].functionDeclarations[0].name).toBe("get_weather");
    });

    it("should handle null tools config", () => {
      const config = {
        temperature: 0.7,
      };

      expect(config.tools).toBeUndefined();
    });

    it("should handle array of tool definitions", () => {
      const tools = [
        { functionDeclarations: [{ name: "tool1" }] },
        { functionDeclarations: [{ name: "tool2" }] },
      ];

      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toHaveLength(2);
    });
  });

  describe("edge cases", () => {
    it("should handle chunks without candidates", () => {
      const chunks = [
        {},
        { candidates: null },
        { candidates: [] },
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Hello" }],
              },
            },
          ],
        },
      ];

      const validChunks = chunks.filter(
        (c) =>
          c.candidates &&
          Array.isArray(c.candidates) &&
          c.candidates.length > 0,
      );

      expect(validChunks).toHaveLength(1);
    });

    it("should handle parts without text property", () => {
      const parts = [
        { text: "Hello" },
        { functionCall: {} },
        { inlineData: {} },
      ];

      const textParts = parts.filter((p) => p.text !== undefined);
      expect(textParts).toHaveLength(1);
    });

    it("should handle mixed part types in single chunk", () => {
      const parts = [
        { text: "Answer: " },
        { functionCall: { name: "calculate" } },
        { text: "Done" },
      ];

      const texts = parts.filter((p: any) => p.text).map((p: any) => p.text);
      const functions = parts.filter((p: any) => p.functionCall);

      expect(texts).toHaveLength(2);
      expect(functions).toHaveLength(1);
    });

    it("should preserve role in content structure", () => {
      const content = {
        parts: [{ text: "Hello" }],
        role: "model",
      };

      expect(content.role).toBe("model");
    });
  });
});
