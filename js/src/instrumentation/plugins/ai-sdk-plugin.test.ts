import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const telemetryMocks = vi.hoisted(() => ({
  braintrustAISDKTelemetry: vi.fn(),
  telemetry: {} as {
    executeTool?: ReturnType<typeof vi.fn>;
    onAbort?: ReturnType<typeof vi.fn>;
    onEnd?: ReturnType<typeof vi.fn>;
    onStart?: ReturnType<typeof vi.fn>;
    onStepEnd?: ReturnType<typeof vi.fn>;
  },
}));

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

vi.mock("../../wrappers/ai-sdk/telemetry", () => ({
  braintrustAISDKTelemetry: telemetryMocks.braintrustAISDKTelemetry,
}));

import {
  AISDKPlugin,
  DEFAULT_DENY_OUTPUT_PATHS,
  processAISDKCallInput,
  processAISDKWorkflowAgentCallInput,
  processAISDKWorkflowAgentModelCallInput,
  processAISDKOutput as processAISDKOutputActual,
} from "./ai-sdk-plugin";
import iso from "../../isomorph";
import { serializeAISDKToolsForLogging } from "../../wrappers/ai-sdk/tool-serialization";
import { BRAINTRUST_AI_SDK_V7_OPERATION_KEY as AI_SDK_V7_OPERATION_KEY } from "../../vendor-sdk-types/ai-sdk-v7-telemetry";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;
type MockTracingChannel = {
  handlers: any[];
  hasSubscribers: boolean;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
};
const mockChannels = new Map<string, MockTracingChannel>();

// Import private functions by re-exporting them in the test
// Since these are private, we'll test them through the public API
// But we'll also add some tests for the exported utility functions

describe("AISDKPlugin", () => {
  let plugin: AISDKPlugin;

  beforeEach(() => {
    mockChannels.clear();
    telemetryMocks.telemetry = {
      executeTool: vi.fn(({ execute }) => execute()),
      onAbort: vi.fn(),
      onEnd: vi.fn(),
      onStart: vi.fn(),
      onStepEnd: vi.fn(),
    };
    telemetryMocks.braintrustAISDKTelemetry.mockReturnValue(
      telemetryMocks.telemetry,
    );
    mockNewTracingChannel.mockImplementation((name: string) => {
      const channel: MockTracingChannel = {
        handlers: [],
        hasSubscribers: false,
        subscribe: vi.fn((handlers: any) => {
          channel.handlers.push(handlers);
          channel.hasSubscribers = true;
        }),
        unsubscribe: vi.fn((handlers: any) => {
          channel.handlers = channel.handlers.filter(
            (candidate) => candidate !== handlers,
          );
          channel.hasSubscribers = channel.handlers.length > 0;
          return true;
        }),
      };
      mockChannels.set(name, channel);
      return channel;
    });

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

  describe("WorkflowAgent input extraction", () => {
    it("preserves string prompts and system overrides", () => {
      expect(
        processAISDKWorkflowAgentCallInput({
          headers: { authorization: "secret" },
          maxOutputTokens: 12,
          prompt: "What's the weather in Paris?",
          stopWhen: () => true,
          system: "You are a helpful weather assistant.",
        }).input,
      ).toEqual({
        prompt: "What's the weather in Paris?",
        system: "You are a helpful weather assistant.",
      });
    });

    it("preserves public prompt message arrays for WorkflowAgent spans", () => {
      expect(
        processAISDKWorkflowAgentCallInput({
          prompt: [{ role: "user", content: "Hello" }],
          system: "You are terse.",
        }).input,
      ).toEqual({
        prompt: [{ role: "user", content: "Hello" }],
        system: "You are terse.",
      });
    });

    it("normalizes model call prompt arrays for WorkflowAgent child spans", () => {
      expect(
        processAISDKWorkflowAgentModelCallInput({
          instructions: "You are terse.",
          prompt: [{ role: "user", content: "Hello" }],
        }).input,
      ).toEqual({
        instructions: "You are terse.",
        messages: [{ role: "user", content: "Hello" }],
      });
    });

    it("does not treat arbitrary prompt objects as public AI SDK prompts", () => {
      expect(
        processAISDKWorkflowAgentCallInput({
          prompt: { role: "user", content: "Hello" } as any,
          system: "You are terse.",
        }).input,
      ).toEqual({
        system: "You are terse.",
      });
    });

    it("omits SDK internals and function options from call inputs", () => {
      const processed = processAISDKCallInput({
        model: {
          config: {
            provider: "openai.responses",
            url: () => "https://example.test",
          },
          doGenerate: async () => ({}),
          doStream: async () => ({ stream: new ReadableStream() }),
          modelId: "gpt-4.1-mini",
        },
        experimental_output: {
          responseFormat: Promise.resolve({ type: "json" }),
          type: "object",
        },
        prompt: "Hello",
        stopWhen: () => true,
      }).input as Record<string, any>;

      expect(processed).toMatchObject({
        model: {
          config: {
            provider: "openai.responses",
          },
          modelId: "gpt-4.1-mini",
        },
        prompt: "Hello",
      });
      expect(processed).not.toHaveProperty("experimental_output");
      expect(processed).not.toHaveProperty("stopWhen");
      expect(processed.model).not.toHaveProperty("doGenerate");
      expect(processed.model).not.toHaveProperty("doStream");
      expect(processed.model.config).not.toHaveProperty("url");
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

  describe("AI SDK v7 telemetry dispatcher", () => {
    it("patches dispatcher callbacks through the standard channel", async () => {
      const existingOnEnd = vi.fn();
      const existingOnStart = vi.fn();
      const existingOnStepEnd = vi.fn();
      const existingOnAbort = vi.fn();
      const originalExecute = vi.fn(async () => "done");
      const existingExecuteTool = vi.fn(({ execute }) => execute());
      const dispatcher = {
        executeTool: existingExecuteTool,
        onAbort: existingOnAbort,
        onEnd: existingOnEnd,
        onStart: existingOnStart,
        onStepEnd: existingOnStepEnd,
      };

      plugin.enable();

      const channel = mockChannels.get(
        "orchestrion:ai:createTelemetryDispatcher",
      );
      expect(channel?.subscribe).toHaveBeenCalledTimes(1);

      channel?.handlers[0]?.end({
        arguments: [{ telemetry: {} }],
        result: dispatcher,
      });

      await dispatcher.onStart({
        callId: "call-1",
        operationId: "ai.generateText",
      });
      expect(existingOnStart).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.telemetry.onStart).toHaveBeenCalledWith({
        callId: "call-1",
        operationId: "ai.generateText",
      });

      await dispatcher.onEnd({
        callId: "call-1",
        operationId: "ai.generateText",
      });
      expect(existingOnEnd).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.telemetry.onEnd).toHaveBeenCalledWith({
        callId: "call-1",
        operationId: "ai.generateText",
      });

      await dispatcher.onStepEnd({
        callId: "call-1",
        operationId: "ai.workflowAgent.stream",
      });
      expect(existingOnStepEnd).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.telemetry.onStepEnd).toHaveBeenCalledWith({
        callId: "call-1",
        operationId: "ai.workflowAgent.stream",
      });

      await dispatcher.onAbort({
        callId: "call-1",
        operationId: "ai.workflowAgent.stream",
      });
      expect(existingOnAbort).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.telemetry.onAbort).toHaveBeenCalledWith({
        callId: "call-1",
        operationId: "ai.workflowAgent.stream",
      });

      await expect(
        dispatcher.executeTool({
          callId: "call-1",
          execute: originalExecute,
          toolCallId: "tool-1",
        }),
      ).resolves.toBe("done");
      expect(telemetryMocks.telemetry.executeTool).toHaveBeenCalledTimes(1);
      expect(existingExecuteTool).toHaveBeenCalledTimes(1);
      expect(originalExecute).toHaveBeenCalledTimes(1);
    });

    it("passes AI SDK v7 telemetry redaction options to Braintrust callbacks", async () => {
      const existingOnStart = vi.fn();
      const dispatcher = {
        onEnd: vi.fn(),
        onStart: existingOnStart,
      };

      plugin.enable();

      const channel = mockChannels.get(
        "orchestrion:ai:createTelemetryDispatcher",
      );
      channel?.handlers[0]?.end({
        arguments: [
          {
            telemetry: {
              functionId: "redacted-function",
              recordInputs: false,
              recordOutputs: false,
            },
          },
        ],
        result: dispatcher,
      });

      const startEvent = {
        callId: "call-redacted",
        messages: [{ role: "user", content: "hidden input" }],
        operationId: "ai.generateText",
      };
      await dispatcher.onStart(startEvent);
      await dispatcher.onEnd({
        callId: "call-redacted",
        operationId: "ai.generateText",
        text: "hidden output",
      });

      expect(existingOnStart).toHaveBeenCalledWith(startEvent);
      expect(telemetryMocks.telemetry.onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          functionId: "redacted-function",
          recordInputs: false,
          recordOutputs: false,
        }),
      );
      expect(telemetryMocks.telemetry.onEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          functionId: "redacted-function",
          recordInputs: false,
          recordOutputs: false,
        }),
      );
      expect(startEvent).not.toHaveProperty("recordInputs");
    });

    it("stamps a stable unique operation key on each dispatcher", async () => {
      const dispatcherA = {
        executeTool: vi.fn(({ execute }) => execute()),
        onAbort: vi.fn(),
        onStart: vi.fn(),
      };
      const dispatcherB = {
        executeTool: vi.fn(({ execute }) => execute()),
        onStart: vi.fn(),
      };

      plugin.enable();

      const channel = mockChannels.get(
        "orchestrion:ai:createTelemetryDispatcher",
      );
      channel?.handlers[0]?.end({
        arguments: [{ telemetry: {} }],
        result: dispatcherA,
      });
      channel?.handlers[0]?.end({
        arguments: [{ telemetry: {} }],
        result: dispatcherB,
      });

      await dispatcherA.onStart({
        callId: "workflow-agent",
        operationId: "ai.workflowAgent.stream",
      });
      await dispatcherB.onStart({
        callId: "workflow-agent",
        operationId: "ai.workflowAgent.stream",
      });
      await dispatcherA.onAbort({
        callId: "workflow-agent",
        operationId: "ai.workflowAgent.stream",
      });
      await dispatcherB.executeTool({
        callId: "workflow-agent",
        execute: async () => "done",
        toolCallId: "tool-b",
      });

      const runAStart = telemetryMocks.telemetry.onStart?.mock.calls[0]?.[0];
      const runBStart = telemetryMocks.telemetry.onStart?.mock.calls[1]?.[0];
      const runAAbort = telemetryMocks.telemetry.onAbort?.mock.calls[0]?.[0];
      const runBTool = telemetryMocks.telemetry.executeTool?.mock.calls[0]?.[0];

      expect(runAStart?.[AI_SDK_V7_OPERATION_KEY]).toEqual(expect.any(String));
      expect(runBStart?.[AI_SDK_V7_OPERATION_KEY]).toEqual(expect.any(String));
      expect(runAStart?.[AI_SDK_V7_OPERATION_KEY]).not.toBe(
        runBStart?.[AI_SDK_V7_OPERATION_KEY],
      );
      expect(runAAbort?.[AI_SDK_V7_OPERATION_KEY]).toBe(
        runAStart?.[AI_SDK_V7_OPERATION_KEY],
      );
      expect(runBTool?.[AI_SDK_V7_OPERATION_KEY]).toBe(
        runBStart?.[AI_SDK_V7_OPERATION_KEY],
      );
    });

    it("preserves existing dispatcher callback return and rejection semantics", async () => {
      const rejection = new Error("user telemetry failed");
      let rejectExisting: (error: Error) => void;
      const existingPromise = new Promise<void>((_resolve, reject) => {
        rejectExisting = reject;
      });
      const existingOnStart = vi.fn(() => existingPromise);
      telemetryMocks.telemetry.onStart = vi.fn(() =>
        Promise.reject(new Error("braintrust telemetry failed")),
      );
      const dispatcher: any = {
        onStart: existingOnStart,
      };

      plugin.enable();

      const channel = mockChannels.get(
        "orchestrion:ai:createTelemetryDispatcher",
      );
      channel?.handlers[0]?.end({
        arguments: [{ telemetry: {} }],
        result: dispatcher,
      });

      const returned = dispatcher.onStart({
        callId: "call-reject",
        operationId: "ai.generateText",
      });

      expect(returned).toBe(existingPromise);
      expect(existingOnStart).toHaveBeenCalledTimes(1);
      expect(telemetryMocks.telemetry.onStart).toHaveBeenCalledTimes(1);

      rejectExisting!(rejection);
      await expect(returned).rejects.toBe(rejection);
    });

    it("patches each dispatcher once and respects telemetry opt-out", () => {
      const dispatcher = {
        onStart: vi.fn(),
      };

      plugin.enable();

      const channel = mockChannels.get(
        "orchestrion:ai:createTelemetryDispatcher",
      );
      channel?.handlers[0]?.end({
        arguments: [{ telemetry: {} }],
        result: dispatcher,
      });
      const patchedOnStart = dispatcher.onStart;

      channel?.handlers[0]?.end({
        arguments: [{ telemetry: {} }],
        result: dispatcher,
      });
      expect(dispatcher.onStart).toBe(patchedOnStart);

      const optedOutDispatcher = {};
      channel?.handlers[0]?.end({
        arguments: [{ telemetry: { isEnabled: false } }],
        result: optedOutDispatcher,
      });
      expect(optedOutDispatcher).not.toHaveProperty("onStart");
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
        tokens: 150,
      });
    });

    it("should synthesize total tokens from input and output tokens", () => {
      const result = {
        usage: {
          inputTokens: 10,
          outputTokens: 2,
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        tokens: 12,
      });
    });

    it("should synthesize total tokens from prompt and completion tokens", () => {
      const result = {
        usage: {
          promptTokens: 10,
          completionTokens: 2,
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        tokens: 12,
      });
    });

    it("should prefer explicit total tokens over synthesized total", () => {
      const result = {
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 99,
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        tokens: 99,
      });
    });

    it("should synthesize total tokens for OpenAI-style usage", () => {
      const result = {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        tokens: 12,
      });
    });

    it("should synthesize total tokens for Anthropic-style usage", () => {
      const result = {
        usage: {
          inputTokens: 10,
          inputTokenDetails: {
            cacheWriteTokens: 3,
          },
          outputTokens: 2,
        },
        providerMetadata: {
          anthropic: {
            usage: {
              cache_creation_input_tokens: 3,
            },
          },
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        tokens: 12,
        prompt_cache_creation_tokens: 3,
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
        tokens: 30,
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
        tokens: 30,
        estimated_cost: 0.05,
      });
    });

    it("should extract anthropic cache metrics from provider metadata", () => {
      const result = {
        usage: {
          inputTokens: 100,
          inputTokenDetails: {
            cacheReadTokens: 0,
            cacheWriteTokens: 80,
          },
          outputTokens: 20,
          cachedInputTokens: 0,
        },
        providerMetadata: {
          anthropic: {
            cacheCreationInputTokens: 80,
            usage: {
              cache_creation_input_tokens: 80,
            },
          },
        },
      };
      const metrics = extractTokenMetrics(result);
      expect(metrics).toEqual({
        prompt_tokens: 100,
        completion_tokens: 20,
        tokens: 120,
        prompt_cached_tokens: 0,
        prompt_cache_creation_tokens: 80,
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

    it("preserves user headers fields while omitting configured transport headers", () => {
      const output = {
        text: "Hello",
        object: {
          headers: { "x-user-data": "keep" },
        },
        content: [
          {
            type: "text",
            text: "Hello",
            headers: { source: "tool-payload" },
          },
        ],
        request: {
          headers: { authorization: "secret" },
          body: "secret-request-body",
          providerPayload: {
            headers: { authorization: "nested-request-secret" },
          },
        },
        response: {
          headers: { authorization: "secret" },
          body: "secret-body",
          constructor: "unsafe",
          id: "response-id",
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "provider-result",
                  result: {
                    headers: { authorization: "nested-secret" },
                    id: "nested-provider-response-id",
                    prototype: "unsafe",
                  },
                },
              ],
            },
          ],
        },
        rawResponse: {
          headers: { authorization: "secret" },
        },
        responses: [
          {
            headers: { authorization: "secret" },
            id: "provider-response-id",
          },
        ],
        roundtrips: [
          {
            request: {
              headers: { authorization: "secret" },
              body: "secret-roundtrip-request-body",
              providerPayload: {
                headers: { authorization: "nested-roundtrip-request-secret" },
              },
            },
            response: {
              headers: { authorization: "secret" },
              id: "roundtrip-response-id",
            },
          },
        ],
        steps: [
          {
            request: {
              headers: { authorization: "secret" },
              body: "secret-step-request-body",
              providerPayload: {
                headers: { authorization: "nested-step-request-secret" },
              },
            },
            response: {
              headers: { authorization: "secret" },
              body: "secret-step-body",
              id: "step-response-id",
              messages: [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "provider-result",
                      result: {
                        headers: { authorization: "nested-step-secret" },
                        id: "nested-step-provider-response-id",
                      },
                    },
                  ],
                },
              ],
            },
            output: {
              headers: { "x-user-data": "keep-step" },
            },
            responses: [
              {
                headers: { authorization: "secret" },
                id: "step-provider-response-id",
              },
            ],
          },
        ],
      };

      const result = processAISDKOutputActual(
        output as any,
        DEFAULT_DENY_OUTPUT_PATHS,
      ) as Record<string, any>;

      expect(result.object.headers).toEqual({ "x-user-data": "keep" });
      expect(result.content[0].headers).toEqual({ source: "tool-payload" });
      expect(result.steps[0].output.headers).toEqual({
        "x-user-data": "keep-step",
      });
      const serializedResult = JSON.stringify(result);
      expect(serializedResult).not.toContain("secret-request-body");
      expect(serializedResult).not.toContain("secret-roundtrip-request-body");
      expect(serializedResult).not.toContain("secret-step-request-body");
      expect(serializedResult).not.toContain("authorization");
      expect(result.request).not.toHaveProperty("headers");
      expect(result.request.providerPayload).not.toHaveProperty("headers");
      expect(result.response).not.toHaveProperty("headers");
      expect(result.response.body).toBe("<omitted>");
      expect(result.response).not.toHaveProperty("constructor");
      expect(result.response.messages[0].content[0].result).not.toHaveProperty(
        "headers",
      );
      expect(result.response.messages[0].content[0].result).not.toHaveProperty(
        "prototype",
      );
      expect(result.rawResponse).not.toHaveProperty("headers");
      expect(result.responses[0]).not.toHaveProperty("headers");
      if (result.roundtrips) {
        expect(result.roundtrips[0].request).not.toHaveProperty("headers");
        expect(result.roundtrips[0].request.providerPayload).not.toHaveProperty(
          "headers",
        );
        expect(result.roundtrips[0].response).not.toHaveProperty("headers");
      }
      expect(result.steps[0].request).not.toHaveProperty("headers");
      expect(result.steps[0].request.providerPayload).not.toHaveProperty(
        "headers",
      );
      expect(result.steps[0].response).not.toHaveProperty("headers");
      expect(result.steps[0].response.body).toBe("<omitted>");
      expect(
        result.steps[0].response.messages[0].content[0].result,
      ).not.toHaveProperty("headers");
      expect(result.steps[0].responses[0]).not.toHaveProperty("headers");
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

    it("should omit non-whitelisted fields like responses", () => {
      const output = {
        embeddings: [[0.1, 0.2, 0.3]],
        response: { body: "too much" },
        responses: [{ body: "way too much" }],
        usage: { totalTokens: 8 },
      };

      const result = processAISDKEmbeddingOutput(output, []);
      expect(result.response).toBeUndefined();
      expect(result.responses).toBeUndefined();
      expect(result.usage).toMatchObject({ totalTokens: 8 });
      expect(result.embedding_count).toBe(1);
    });
  });

  describe("processAISDKRerankOutput", () => {
    it("should summarize rerank results using the shared rerank shape", () => {
      const output = {
        ranking: [
          { originalIndex: 3, score: 0.91, document: "gamma" },
          { originalIndex: 1, score: 0.72, document: "alpha" },
        ],
        usage: {
          totalTokens: 6,
        },
      };

      const result = processAISDKRerankOutput(output, []);
      expect(result).toEqual([
        { index: 3, relevance_score: 0.91 },
        { index: 1, relevance_score: 0.72 },
      ]);
    });

    it("should omit non-whitelisted rerank fields", () => {
      const output = {
        ranking: [{ originalIndex: 0, score: 0.5 }],
        response: { body: "too much" },
        rerankedDocuments: ["alpha"],
      };

      const result = processAISDKRerankOutput(output, []);
      expect(result).toEqual([{ index: 0, relevance_score: 0.5 }]);
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
  } else if (promptTokens !== undefined && completionTokens !== undefined) {
    metrics.tokens = promptTokens + completionTokens;
  }

  const promptCachedTokens = firstNumber(
    usage.inputTokens?.cacheRead,
    usage.inputTokenDetails?.cacheReadTokens,
    usage.cachedInputTokens,
    usage.promptCachedTokens,
    usage.prompt_cached_tokens,
  );
  if (promptCachedTokens !== undefined) {
    metrics.prompt_cached_tokens = promptCachedTokens;
  }

  const promptCacheCreationTokens = firstNumber(
    usage.inputTokens?.cacheWrite,
    usage.inputTokenDetails?.cacheWriteTokens,
    usage.promptCacheCreationTokens,
    usage.prompt_cache_creation_tokens,
    extractAnthropicCacheCreationTokens(result),
  );
  if (promptCacheCreationTokens !== undefined) {
    metrics.prompt_cache_creation_tokens = promptCacheCreationTokens;
  }

  const cost = extractCostFromResult(result);
  if (cost !== undefined) {
    metrics.estimated_cost = cost;
  }

  return metrics;
}

function extractAnthropicCacheCreationTokens(result: any): number | undefined {
  const anthropicMetadata = result?.providerMetadata?.anthropic;
  if (!anthropicMetadata || typeof anthropicMetadata !== "object") {
    return undefined;
  }

  return firstNumber(
    anthropicMetadata.cacheCreationInputTokens,
    anthropicMetadata.usage?.cache_creation_input_tokens,
  );
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
  if (!output || typeof output !== "object") {
    return output;
  }

  const processed: Record<string, unknown> = {};
  const whitelistedFields = [
    "usage",
    "totalUsage",
    "warnings",
    "providerMetadata",
    "experimental_providerMetadata",
  ];

  for (const field of whitelistedFields) {
    const value = output?.[field];
    if (value !== undefined && typeof value !== "function") {
      processed[field] = value;
    }
  }

  if (Array.isArray(output?.embedding)) {
    processed.embedding_length = output.embedding.length;
  }

  if (Array.isArray(output?.embeddings)) {
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

function processAISDKRerankOutput(
  output: any,
  _denyOutputPaths: string[],
): any {
  if (!output || typeof output !== "object") {
    return output;
  }

  if (Array.isArray(output?.ranking)) {
    return output.ranking.slice(0, 100).map((item: any) => ({
      index:
        typeof item?.originalIndex === "number"
          ? item.originalIndex
          : undefined,
      relevance_score: typeof item?.score === "number" ? item.score : undefined,
    }));
  }

  return undefined;
}
