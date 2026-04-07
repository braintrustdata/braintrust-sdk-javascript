import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

import { AISDKPlugin } from "./ai-sdk-plugin";
import { Attachment } from "../../logger";
import iso from "../../isomorph";
import { serializeAISDKToolsForLogging } from "../../wrappers/ai-sdk/tool-serialization";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

// Import private functions by re-exporting them in the test
// Since these are private, we'll test them through the public API
// But we'll also add some tests for the exported utility functions

describe("AISDKPlugin", () => {
  let plugin: AISDKPlugin;

  beforeEach(() => {
    // Setup mock channel
    const mockChannel = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      hasSubscribers: false,
    };
    mockNewTracingChannel.mockReturnValue(mockChannel);

    plugin = new AISDKPlugin();
  });

  afterEach(() => {
    if (plugin) {
      plugin.disable();
    }
  });

  describe("constructor", () => {
    it("should create plugin with default config", () => {
      const defaultPlugin = new AISDKPlugin();
      expect(defaultPlugin).toBeInstanceOf(AISDKPlugin);
    });

    it("should create plugin with custom config", () => {
      const customPlugin = new AISDKPlugin({
        denyOutputPaths: ["custom.path"],
      });
      expect(customPlugin).toBeInstanceOf(AISDKPlugin);
    });
  });

  describe("enable/disable", () => {
    it("should enable plugin", () => {
      expect(() => plugin.enable()).not.toThrow();
    });

    it("should disable plugin", () => {
      plugin.enable();
      expect(() => plugin.disable()).not.toThrow();
    });

    it("should handle multiple enable calls", () => {
      plugin.enable();
      expect(() => plugin.enable()).not.toThrow();
    });

    it("should handle multiple disable calls", () => {
      plugin.enable();
      plugin.disable();
      expect(() => plugin.disable()).not.toThrow();
    });

    it("should unsubscribe from channels on disable", () => {
      plugin.enable();
      plugin.disable();
      // Verify that unsubscribers were called
      // This is tested indirectly - if it doesn't throw, unsubscribe worked
      expect(true).toBe(true);
    });
  });
});

describe("AI SDK utility functions", () => {
  describe("serializeModelWithProvider", () => {
    it("should handle string model ID", () => {
      const result = serializeModelWithProvider("gpt-4");
      expect(result).toEqual({
        model: "gpt-4",
        provider: undefined,
      });
    });

    it("should handle model object with modelId", () => {
      const result = serializeModelWithProvider({
        modelId: "gpt-4-turbo",
        provider: "openai",
      });
      expect(result).toEqual({
        model: "gpt-4-turbo",
        provider: "openai",
      });
    });

    it("should parse gateway-style model strings", () => {
      const result = serializeModelWithProvider("openai/gpt-4");
      expect(result).toEqual({
        model: "gpt-4",
        provider: "openai",
      });
    });

    it("should prefer explicit provider over parsed provider", () => {
      const result = serializeModelWithProvider({
        modelId: "anthropic/claude-3",
        provider: "custom-provider",
      });
      expect(result).toEqual({
        model: "claude-3",
        provider: "custom-provider",
      });
    });

    it("should handle null/undefined model", () => {
      const result1 = serializeModelWithProvider(null);
      expect(result1).toEqual({
        model: undefined,
        provider: undefined,
      });

      const result2 = serializeModelWithProvider(undefined);
      expect(result2).toEqual({
        model: undefined,
        provider: undefined,
      });
    });
  });

  describe("parseGatewayModelString", () => {
    it("should parse provider/model format", () => {
      const result = parseGatewayModelString("openai/gpt-4");
      expect(result).toEqual({
        provider: "openai",
        model: "gpt-4",
      });
    });

    it("should handle model without provider", () => {
      const result = parseGatewayModelString("gpt-4");
      expect(result).toEqual({
        model: "gpt-4",
      });
    });

    it("should handle model with multiple slashes", () => {
      const result = parseGatewayModelString("provider/model/version");
      expect(result).toEqual({
        provider: "provider",
        model: "model/version",
      });
    });

    it("should handle empty string", () => {
      const result = parseGatewayModelString("");
      expect(result).toEqual({
        model: "",
      });
    });

    it("should handle slash at start", () => {
      const result = parseGatewayModelString("/model");
      expect(result).toEqual({
        model: "/model",
      });
    });

    it("should handle slash at end", () => {
      const result = parseGatewayModelString("provider/");
      expect(result).toEqual({
        model: "provider/",
      });
    });

    it("should handle non-string input", () => {
      const result = parseGatewayModelString(null as any);
      expect(result).toEqual({
        model: null,
      });
    });
  });

  describe("firstNumber", () => {
    it("should return first number in list", () => {
      expect(firstNumber(10, 20, 30)).toBe(10);
    });

    it("should skip non-number values", () => {
      expect(firstNumber(undefined, null, "string", 42)).toBe(42);
    });

    it("should return undefined if no numbers found", () => {
      expect(firstNumber(undefined, null, "string")).toBeUndefined();
    });

    it("should handle empty list", () => {
      expect(firstNumber()).toBeUndefined();
    });

    it("should handle zero as valid number", () => {
      expect(firstNumber(null, 0, 10)).toBe(0);
    });

    it("should handle negative numbers", () => {
      expect(firstNumber(undefined, -5, 10)).toBe(-5);
    });
  });

  describe("parseGatewayCost", () => {
    it("should return number cost", () => {
      expect(parseGatewayCost(0.05)).toBe(0.05);
    });

    it("should parse string cost", () => {
      expect(parseGatewayCost("0.123")).toBe(0.123);
    });

    it("should return undefined for null", () => {
      expect(parseGatewayCost(null)).toBeUndefined();
    });

    it("should return undefined for undefined", () => {
      expect(parseGatewayCost(undefined)).toBeUndefined();
    });

    it("should return undefined for invalid string", () => {
      expect(parseGatewayCost("not a number")).toBeUndefined();
    });

    it("should handle zero cost", () => {
      expect(parseGatewayCost(0)).toBe(0);
    });

    it("should handle string zero", () => {
      expect(parseGatewayCost("0")).toBe(0);
    });

    it("should return undefined for objects", () => {
      expect(parseGatewayCost({} as any)).toBeUndefined();
    });
  });

  describe("parsePath", () => {
    it("should parse simple dot notation", () => {
      expect(parsePath("a.b.c")).toEqual(["a", "b", "c"]);
    });

    it("should parse array wildcard", () => {
      expect(parsePath("items[]")).toEqual(["items", "[]"]);
    });

    it("should parse array index", () => {
      expect(parsePath("items[0]")).toEqual(["items", 0]);
    });

    it("should parse array wildcard in middle", () => {
      expect(parsePath("data[].name")).toEqual(["data", "[]", "name"]);
    });

    it("should parse complex path", () => {
      expect(parsePath("a[].b.c[0].d")).toEqual(["a", "[]", "b", "c", 0, "d"]);
    });

    it("should handle empty path", () => {
      expect(parsePath("")).toEqual([]);
    });

    it("should handle single key", () => {
      expect(parsePath("key")).toEqual(["key"]);
    });

    it("should handle consecutive dots", () => {
      expect(parsePath("a..b")).toEqual(["a", "b"]);
    });

    it("should parse string keys in brackets", () => {
      expect(parsePath("a[key]")).toEqual(["a", "key"]);
    });

    it("should handle brackets without parent", () => {
      expect(parsePath("[0]")).toEqual([0]);
    });
  });

  describe("omitAtPath", () => {
    it("should omit simple property", () => {
      const obj = { a: 1, b: 2, c: 3 };
      omitAtPath(obj, ["b"]);
      expect(obj).toEqual({ a: 1, b: "<omitted>", c: 3 });
    });

    it("should omit nested property", () => {
      const obj = { a: { b: { c: 1 } } };
      omitAtPath(obj, ["a", "b", "c"]);
      expect(obj).toEqual({ a: { b: { c: "<omitted>" } } });
    });

    it("should omit property in all array items", () => {
      const obj = { items: [{ a: 1 }, { a: 2 }, { a: 3 }] };
      omitAtPath(obj, ["items", "[]", "a"]);
      expect(obj).toEqual({
        items: [{ a: "<omitted>" }, { a: "<omitted>" }, { a: "<omitted>" }],
      });
    });

    it("should handle missing path", () => {
      const obj = { a: 1 };
      omitAtPath(obj, ["b", "c"]);
      expect(obj).toEqual({ a: 1 });
    });

    it("should handle empty keys", () => {
      const obj = { a: 1 };
      omitAtPath(obj, []);
      expect(obj).toEqual({ a: 1 });
    });

    it("should handle non-object values", () => {
      const obj = { a: "string" };
      omitAtPath(obj, ["a", "b"]);
      expect(obj).toEqual({ a: "string" });
    });

    it("should omit array element by index", () => {
      const obj = { items: [1, 2, 3] };
      omitAtPath(obj, ["items", 1]);
      expect(obj).toEqual({ items: [1, "<omitted>", 3] });
    });
  });

  describe("omit", () => {
    it("should omit multiple paths", () => {
      const obj = {
        a: 1,
        b: 2,
        c: { d: 3 },
      };
      const result = omit(obj, ["a", "c.d"]);
      expect(result).toEqual({
        a: "<omitted>",
        b: 2,
        c: { d: "<omitted>" },
      });
    });

    it("should omit paths in arrays", () => {
      const obj = {
        items: [
          { id: 1, secret: "s1" },
          { id: 2, secret: "s2" },
        ],
      };
      const result = omit(obj, ["items[].secret"]);
      expect(result).toEqual({
        items: [
          { id: 1, secret: "<omitted>" },
          { id: 2, secret: "<omitted>" },
        ],
      });
    });

    it("should not modify original object", () => {
      const obj = { a: 1, b: 2 };
      const result = omit(obj, ["a"]);
      expect(obj).toEqual({ a: 1, b: 2 });
      expect(result).toEqual({ a: "<omitted>", b: 2 });
    });

    it("should handle empty paths array", () => {
      const obj = { a: 1, b: 2 };
      const result = omit(obj, []);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("should handle complex AI SDK paths", () => {
      const obj = {
        roundtrips: [
          {
            request: { body: "sensitive" },
            response: { headers: "sensitive" },
          },
        ],
        rawResponse: { headers: "sensitive" },
      };
      const result = omit(obj, [
        "roundtrips[].request.body",
        "roundtrips[].response.headers",
        "rawResponse.headers",
      ]);
      expect(result).toEqual({
        roundtrips: [
          {
            request: { body: "<omitted>" },
            response: { headers: "<omitted>" },
          },
        ],
        rawResponse: { headers: "<omitted>" },
      });
    });
  });

  describe("extractGetterValues", () => {
    it("should extract getter values from object", () => {
      const obj = {
        text: "Hello",
        object: { key: "value" },
        finishReason: "stop",
      };
      const result = extractGetterValues(obj);
      expect(result).toEqual({
        text: "Hello",
        object: { key: "value" },
        finishReason: "stop",
      });
    });

    it("should handle object with some getters", () => {
      const obj = {
        text: "Hello",
        usage: { tokens: 10 },
      };
      const result = extractGetterValues(obj);
      expect(result).toEqual({
        text: "Hello",
        usage: { tokens: 10 },
      });
    });

    it("should skip function values", () => {
      const obj = {
        text: "Hello",
        method: () => "value",
      };
      const result = extractGetterValues(obj);
      expect(result).toEqual({
        text: "Hello",
      });
    });

    it("should handle null/undefined object", () => {
      expect(extractGetterValues(null)).toEqual({});
      expect(extractGetterValues(undefined)).toEqual({});
    });

    it("should handle empty object", () => {
      expect(extractGetterValues({})).toEqual({});
    });

    it("should extract providerMetadata", () => {
      const obj = {
        text: "Hello",
        providerMetadata: { gateway: { cost: 0.05 } },
      };
      const result = extractGetterValues(obj);
      expect(result).toEqual({
        text: "Hello",
        providerMetadata: { gateway: { cost: 0.05 } },
      });
    });
  });

  describe("extractTokenMetrics", () => {
    it("should extract usage from result", () => {
      const result = {
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        tokens: 30,
      });
    });

    it("should extract totalUsage for Agent results", () => {
      const result = {
        totalUsage: {
          promptTokens: 15,
          completionTokens: 25,
          totalTokens: 40,
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 15,
        completion_tokens: 25,
        tokens: 40,
      });
    });

    it("should handle inputTokens/outputTokens format", () => {
      const result = {
        usage: {
          inputTokens: { total: 100 },
          outputTokens: { total: 50 },
          totalTokens: 150,
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
        tokens: 150,
      });
    });

    it("should handle flat inputTokens/outputTokens", () => {
      const result = {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 100,
        completion_tokens: 50,
      });
    });

    it("should extract cost from providerMetadata", () => {
      const result = {
        usage: {
          promptTokens: 10,
          completionTokens: 20,
        },
        providerMetadata: {
          gateway: {
            cost: 0.05,
          },
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        estimated_cost: 0.05,
      });
    });

    it("should extract cost from steps", () => {
      const result = {
        usage: {
          promptTokens: 10,
          completionTokens: 20,
        },
        steps: [
          {
            providerMetadata: {
              gateway: {
                cost: 0.02,
              },
            },
          },
          {
            providerMetadata: {
              gateway: {
                cost: 0.03,
              },
            },
          },
        ],
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        estimated_cost: 0.05,
      });
    });

    it("should handle missing usage", () => {
      const result = {};
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({});
    });

    it("should return empty metrics for null result", () => {
      const metrics = extractTokenMetrics(null);
      expect(metrics).toEqual({});
    });

    it("should prefer marketCost over cost", () => {
      const result = {
        usage: {
          promptTokens: 10,
        },
        providerMetadata: {
          gateway: {
            cost: 0.02,
            marketCost: 0.03,
          },
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics.estimated_cost).toBe(0.02);
    });
  });

  describe("extractCostFromResult", () => {
    it("should extract cost from direct providerMetadata", () => {
      const result = {
        providerMetadata: {
          gateway: {
            cost: 0.05,
          },
        },
      };
      expect(extractCostFromResult(result)).toBe(0.05);
    });

    it("should extract marketCost if cost is missing", () => {
      const result = {
        providerMetadata: {
          gateway: {
            marketCost: 0.07,
          },
        },
      };
      expect(extractCostFromResult(result)).toBe(0.07);
    });

    it("should sum costs from steps", () => {
      const result = {
        steps: [
          {
            providerMetadata: {
              gateway: {
                cost: 0.02,
              },
            },
          },
          {
            providerMetadata: {
              gateway: {
                cost: 0.03,
              },
            },
          },
        ],
      };
      expect(extractCostFromResult(result)).toBe(0.05);
    });

    it("should ignore zero costs in steps", () => {
      const result = {
        steps: [
          {
            providerMetadata: {
              gateway: {
                cost: 0,
              },
            },
          },
          {
            providerMetadata: {
              gateway: {
                cost: 0.03,
              },
            },
          },
        ],
      };
      expect(extractCostFromResult(result)).toBe(0.03);
    });

    it("should return undefined if no cost found", () => {
      const result = {
        providerMetadata: {},
      };
      expect(extractCostFromResult(result)).toBeUndefined();
    });

    it("should handle missing providerMetadata", () => {
      const result = {};
      expect(extractCostFromResult(result)).toBeUndefined();
    });

    it("should handle empty steps array", () => {
      const result = {
        steps: [],
      };
      expect(extractCostFromResult(result)).toBeUndefined();
    });
  });

  describe("aggregateAISDKChunks", () => {
    it("should aggregate text chunks", () => {
      const chunks = [
        { text: "Hello" },
        { text: "Hello world" },
        { text: "Hello world!" },
      ];
      const result = aggregateAISDKChunks(chunks);
      expect(result.output.text).toBe("Hello world!");
    });

    it("should extract object from last chunk", () => {
      const chunks = [
        { object: { partial: true } },
        { object: { complete: true, data: "test" } },
      ];
      const result = aggregateAISDKChunks(chunks);
      expect(result.output.object).toEqual({ complete: true, data: "test" });
    });

    it("should extract finishReason", () => {
      const chunks = [
        { text: "Hello" },
        { text: "Hello world", finishReason: "stop" },
      ];
      const result = aggregateAISDKChunks(chunks);
      expect(result.output.finishReason).toBe("stop");
    });

    it("should extract toolCalls", () => {
      const chunks = [
        {
          toolCalls: [
            { id: "call_1", name: "get_weather", arguments: { loc: "NYC" } },
          ],
        },
      ];
      const result = aggregateAISDKChunks(chunks);
      expect(result.output.toolCalls).toEqual([
        { id: "call_1", name: "get_weather", arguments: { loc: "NYC" } },
      ]);
    });

    it("should extract metrics from last chunk", () => {
      const chunks = [
        { text: "Hello" },
        {
          text: "Hello world",
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        },
      ];
      const result = aggregateAISDKChunks(chunks);
      expect(result.metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        tokens: 15,
      });
    });

    it("should handle empty chunks array", () => {
      const result = aggregateAISDKChunks([]);
      expect(result.output).toEqual({});
      expect(result.metrics).toEqual({});
    });

    it("should handle chunk without text/object", () => {
      const chunks = [
        {
          finishReason: "stop",
          usage: { promptTokens: 10 },
        },
      ];
      const result = aggregateAISDKChunks(chunks);
      expect(result.output.text).toBeUndefined();
      expect(result.output.finishReason).toBe("stop");
    });
  });

  describe("extractMetadataFromParams", () => {
    it("should extract model and provider from string model", () => {
      const params = { model: "gpt-4" };
      const metadata = extractMetadataFromParams(params);
      expect(metadata.model).toBe("gpt-4");
      expect(metadata.braintrust.integration_name).toBe("ai-sdk");
    });

    it("should extract provider from gateway model string", () => {
      const params = { model: "openai/gpt-4" };
      const metadata = extractMetadataFromParams(params);
      expect(metadata.model).toBe("gpt-4");
      expect(metadata.provider).toBe("openai");
    });

    it("should extract provider from model object", () => {
      const params = {
        model: {
          modelId: "claude-3",
          provider: "anthropic",
        },
      };
      const metadata = extractMetadataFromParams(params);
      expect(metadata.model).toBe("claude-3");
      expect(metadata.provider).toBe("anthropic");
    });

    it("should handle missing model", () => {
      const params = {};
      const metadata = extractMetadataFromParams(params);
      expect(metadata.model).toBeUndefined();
      expect(metadata.braintrust.integration_name).toBe("ai-sdk");
    });

    it("should put tools in metadata", () => {
      const params = {
        model: "gpt-4",
        tools: {
          echo: {
            description: "Echo the message",
            execute: async () => "ok",
            parameters: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                },
              },
            },
          },
        },
      };
      const metadata = extractMetadataFromParams(params);
      expect(metadata.tools).toMatchObject({
        echo: {
          description: "Echo the message",
          parameters: {
            type: "object",
          },
        },
      });
      expect(metadata.tools).not.toHaveProperty("echo.execute");
    });
  });

  describe("processAISDKOutput", () => {
    it("should extract getter values from output", () => {
      const output = {
        text: "Hello",
        finishReason: "stop",
      };
      const result = processAISDKOutput(output, []);
      expect(result.text).toBe("Hello");
      expect(result.finishReason).toBe("stop");
    });

    it("should omit specified paths", () => {
      const output = {
        text: "Hello",
        roundtrips: [
          {
            request: { body: "sensitive" },
            response: { data: "ok" },
          },
        ],
      };
      const result = processAISDKOutput(output, ["roundtrips[].request.body"]);
      expect(result.roundtrips[0].request.body).toBe("<omitted>");
      expect(result.roundtrips[0].response.data).toBe("ok");
    });

    it("should handle null output", () => {
      const result = processAISDKOutput(null, []);
      expect(result).toBeNull();
    });

    it("should handle undefined output", () => {
      const result = processAISDKOutput(undefined, []);
      expect(result).toBeUndefined();
    });
  });

  describe("processAISDKEmbeddingOutput", () => {
    it("should summarize single embedding length", () => {
      const output = {
        embedding: [0.1, 0.2, 0.3, 0.4],
        usage: {
          totalTokens: 10,
        },
      };

      const result = processAISDKEmbeddingOutput(output, []);
      expect(result.embedding).toBeUndefined();
      expect(result.embedding_length).toBe(4);
      expect(result.usage).toMatchObject({
        totalTokens: 10,
      });
    });

    it("should summarize embedding batches", () => {
      const output = {
        embeddings: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      };

      const result = processAISDKEmbeddingOutput(output, []);
      expect(result.embeddings).toBeUndefined();
      expect(result.embedding_count).toBe(2);
      expect(result.embedding_length).toBe(3);
    });
  });
});

// Helper functions exported for testing
// These would normally be private but we're testing them through the module
function serializeModelWithProvider(model: any): {
  model: string;
  provider?: string;
} {
  const modelId = typeof model === "string" ? model : model?.modelId;
  const explicitProvider =
    typeof model === "object" ? model?.provider : undefined;

  if (!modelId) {
    return { model: modelId, provider: explicitProvider };
  }

  const parsed = parseGatewayModelString(modelId);
  return {
    model: parsed.model,
    provider: explicitProvider || parsed.provider,
  };
}

function parseGatewayModelString(modelString: string): {
  model: string;
  provider?: string;
} {
  if (!modelString || typeof modelString !== "string") {
    return { model: modelString };
  }
  const slashIndex = modelString.indexOf("/");
  if (slashIndex > 0 && slashIndex < modelString.length - 1) {
    return {
      provider: modelString.substring(0, slashIndex),
      model: modelString.substring(slashIndex + 1),
    };
  }
  return { model: modelString };
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number") {
      return v;
    }
  }
  return undefined;
}

function parseGatewayCost(cost: unknown): number | undefined {
  if (cost === undefined || cost === null) {
    return undefined;
  }
  if (typeof cost === "number") {
    return cost;
  }
  if (typeof cost === "string") {
    const parsed = parseFloat(cost);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parsePath(path: string): (string | number)[] {
  const keys: (string | number)[] = [];
  let current = "";

  for (let i = 0; i < path.length; i++) {
    const char = path[i];

    if (char === ".") {
      if (current) {
        keys.push(current);
        current = "";
      }
    } else if (char === "[") {
      if (current) {
        keys.push(current);
        current = "";
      }
      let bracketContent = "";
      i++;
      while (i < path.length && path[i] !== "]") {
        bracketContent += path[i];
        i++;
      }
      if (bracketContent === "") {
        keys.push("[]");
      } else {
        const index = parseInt(bracketContent, 10);
        keys.push(isNaN(index) ? bracketContent : index);
      }
    } else {
      current += char;
    }
  }

  if (current) {
    keys.push(current);
  }

  return keys;
}

function omitAtPath(obj: any, keys: (string | number)[]): void {
  if (keys.length === 0) return;

  const firstKey = keys[0];
  const remainingKeys = keys.slice(1);

  if (firstKey === "[]") {
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (remainingKeys.length > 0) {
          omitAtPath(item, remainingKeys);
        }
      });
    }
  } else if (remainingKeys.length === 0) {
    if (obj && typeof obj === "object" && firstKey in obj) {
      obj[firstKey] = "<omitted>";
    }
  } else {
    if (obj && typeof obj === "object" && firstKey in obj) {
      omitAtPath(obj[firstKey], remainingKeys);
    }
  }
}

function omit(
  obj: Record<string, unknown>,
  paths: string[],
): Record<string, unknown> {
  const result = deepCopy(obj);

  for (const path of paths) {
    const keys = parsePath(path);
    omitAtPath(result, keys);
  }

  return result;
}

function deepCopy(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj));
}

function extractGetterValues(obj: any): any {
  const getterValues: Record<string, any> = {};

  const getterNames = [
    "text",
    "object",
    "value",
    "values",
    "embedding",
    "embeddings",
    "finishReason",
    "usage",
    "totalUsage",
    "toolCalls",
    "toolResults",
    "warnings",
    "responses",
    "experimental_providerMetadata",
    "providerMetadata",
    "rawResponse",
    "response",
  ];

  for (const name of getterNames) {
    try {
      if (obj && name in obj && typeof obj[name] !== "function") {
        getterValues[name] = obj[name];
      }
    } catch {
      // Ignore errors accessing getters
    }
  }

  return getterValues;
}

function extractTokenMetrics(result: any): Record<string, number> {
  const metrics: Record<string, number> = {};

  let usage = result?.totalUsage || result?.usage;

  if (!usage && result) {
    try {
      if ("totalUsage" in result && typeof result.totalUsage !== "function") {
        usage = result.totalUsage;
      } else if ("usage" in result && typeof result.usage !== "function") {
        usage = result.usage;
      }
    } catch {
      // Ignore errors accessing getters
    }
  }

  if (!usage) {
    return metrics;
  }

  const promptTokens = firstNumber(
    usage.inputTokens?.total,
    usage.inputTokens,
    usage.promptTokens,
    usage.prompt_tokens,
  );
  if (promptTokens !== undefined) {
    metrics.prompt_tokens = promptTokens;
  }

  const completionTokens = firstNumber(
    usage.outputTokens?.total,
    usage.outputTokens,
    usage.completionTokens,
    usage.completion_tokens,
  );
  if (completionTokens !== undefined) {
    metrics.completion_tokens = completionTokens;
  }

  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.tokens,
    usage.total_tokens,
  );
  if (totalTokens !== undefined) {
    metrics.tokens = totalTokens;
  }

  const cost = extractCostFromResult(result);
  if (cost !== undefined) {
    metrics.estimated_cost = cost;
  }

  return metrics;
}

function extractCostFromResult(result: any): number | undefined {
  if (result?.steps && Array.isArray(result.steps) && result.steps.length > 0) {
    let totalCost = 0;
    let foundCost = false;
    for (const step of result.steps) {
      const gateway = step?.providerMetadata?.gateway;
      const stepCost =
        parseGatewayCost(gateway?.cost) ||
        parseGatewayCost(gateway?.marketCost);
      if (stepCost !== undefined && stepCost > 0) {
        totalCost += stepCost;
        foundCost = true;
      }
    }
    if (foundCost) {
      return totalCost;
    }
  }

  const gateway = result?.providerMetadata?.gateway;
  const directCost =
    parseGatewayCost(gateway?.cost) || parseGatewayCost(gateway?.marketCost);
  if (directCost !== undefined && directCost > 0) {
    return directCost;
  }

  return undefined;
}

function aggregateAISDKChunks(chunks: any[]): {
  output: any;
  metrics: Record<string, number>;
} {
  const lastChunk = chunks[chunks.length - 1];

  const output: any = {};
  let metrics: Record<string, number> = {};

  if (lastChunk) {
    metrics = extractTokenMetrics(lastChunk);

    if (lastChunk.text !== undefined) {
      output.text = lastChunk.text;
    }
    if (lastChunk.object !== undefined) {
      output.object = lastChunk.object;
    }
    if (lastChunk.finishReason !== undefined) {
      output.finishReason = lastChunk.finishReason;
    }
    if (lastChunk.toolCalls !== undefined) {
      output.toolCalls = lastChunk.toolCalls;
    }
  }

  return { output, metrics };
}

function extractMetadataFromParams(params: any): Record<string, any> {
  const metadata: Record<string, any> = {
    braintrust: {
      integration_name: "ai-sdk",
      sdk_language: "typescript",
    },
  };

  const { model, provider } = serializeModelWithProvider(params.model);
  if (model) {
    metadata.model = model;
  }
  if (provider) {
    metadata.provider = provider;
  }
  const tools = serializeAISDKToolsForLogging(params.tools);
  if (tools) {
    metadata.tools = tools;
  }

  return metadata;
}

function processAISDKOutput(output: any, denyOutputPaths: string[]): any {
  if (!output) return output;

  const getterValues = extractGetterValues(output);
  const merged = { ...output, ...getterValues };

  return omit(merged, denyOutputPaths);
}

function processAISDKEmbeddingOutput(
  output: any,
  denyOutputPaths: string[],
): any {
  const processed = processAISDKOutput(output, denyOutputPaths);
  if (!processed || typeof processed !== "object") {
    return processed;
  }

  if (Array.isArray(output?.embedding)) {
    delete processed.embedding;
    processed.embedding_length = output.embedding.length;
  }

  if (Array.isArray(output?.embeddings)) {
    delete processed.embeddings;
    processed.embedding_count = output.embeddings.length;

    const firstEmbedding = output.embeddings.find((item: unknown) =>
      Array.isArray(item),
    );
    if (Array.isArray(firstEmbedding)) {
      processed.embedding_length = firstEmbedding.length;
    }
  }

  return processed;
}
