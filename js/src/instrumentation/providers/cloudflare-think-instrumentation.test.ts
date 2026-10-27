import { resetInstrumentationForTest } from "../test-utils/reset";
import { registerInstrumentation as registerAISDKInstrumentation } from "../registrations/aisdk";
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";
import * as ai from "ai";
import { configureNode } from "../../node/config";
import { _exportsForTestingOnly } from "../../logger/testing";
import {
  currentSpan,
  initLogger,
  withCurrent,
  type TestBackgroundLogger,
} from "../../logger/core";
import { wrapAISDK } from "../../wrappers/ai-sdk";
import { wrapCloudflareThink } from "../../wrappers/cloudflare-think";
import { braintrustAISDKTelemetry } from "../../wrappers/ai-sdk/telemetry";
import { aiSDKChannels } from "./ai-sdk-interceptors";
import { registry } from "../registry";
import { cloudflareThinkSpanCountForTesting } from "./cloudflare-think-context";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("Cloudflare Think instrumentation", () => {
  let backgroundLogger: TestBackgroundLogger;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "cloudflare-think-instrumentation.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    expect(cloudflareThinkSpanCountForTesting()).toBe(0);
  });

  it("creates one task with the model call directly beneath it", async () => {
    const wrappedAI = wrapAISDK(ai);
    const model = makeStreamingModel("Hello from Think");
    class Think {
      messages = [{ role: "user", content: "Say hello" }];

      async _runInferenceLoop() {
        return wrappedAI.streamText({
          model,
          messages: this.messages,
        });
      }
    }
    const { Think: WrappedThink } = wrapCloudflareThink({ Think });
    const result = await new WrappedThink()._runInferenceLoop();

    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
    }
    await result.text;
    expect(text).toBe("Hello from Think");

    const spans = (await backgroundLogger.drain()) as any[];
    const task = spans.find(
      (span) => span.span_attributes?.name === "Think.runTurn",
    );
    const modelSpan = spans.find(
      (span) => span.span_attributes?.name === "doStream",
    );

    expect(spans).toHaveLength(2);
    expect(task).toMatchObject({
      context: {
        span_origin: {
          instrumentation: { name: "cloudflare-think" },
          name: "braintrust.sdk.javascript",
        },
      },
      span_attributes: { name: "Think.runTurn", type: "task" },
      input: [{ role: "user", content: "Say hello" }],
      output: { role: "assistant", content: "Hello from Think" },
      metadata: {
        braintrust: {
          integration_name: "cloudflare-think",
          sdk_language: "typescript",
        },
        model: "think-model",
        provider: "think-provider",
      },
      metrics: {
        completion_tokens: 4,
        prompt_tokens: 3,
        tokens: 7,
      },
    });
    expect(modelSpan?.span_parents).toEqual([task?.span_id]);
    expect(
      spans.some((span) => span.span_attributes?.name === "streamText"),
    ).toBe(false);
  });

  it("records failures and releases the active Think context", async () => {
    const error = new Error("inference failed");
    class Think {
      messages = [{ role: "user", content: "Fail now" }];

      async _runInferenceLoop() {
        throw error;
      }
    }
    const { Think: WrappedThink } = wrapCloudflareThink({ Think });

    await expect(new WrappedThink()._runInferenceLoop()).rejects.toBe(error);

    const spans = (await backgroundLogger.drain()) as any[];
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      input: [{ role: "user", content: "Fail now" }],
      span_attributes: { name: "Think.runTurn", type: "task" },
    });
    expect(spans[0].error).toBeDefined();
  });

  it("keeps concurrent AI SDK 7 turns open until telemetry finishes", async () => {
    const telemetry = braintrustAISDKTelemetry();
    const starts: (() => void)[] = [];
    class Think {
      async _runInferenceLoop(input: { body: string }) {
        return aiSDKChannels.streamTextV7.invoke(
          () => {
            // AI SDK 7 starts telemetry asynchronously, after returning its
            // result. Preserve that context while letting Think resolve first.
            const span = currentSpan();
            starts.push(() =>
              withCurrent(span, () =>
                telemetry.onStart({
                  callId: input.body,
                  operationId: "ai.streamText",
                  modelId: "think-model",
                  provider: "think-provider",
                  messages: [{ role: "user", content: input.body }],
                }),
              ),
            );
            return {};
          },
          undefined,
          [{}],
          {},
        );
      }
    }
    wrapCloudflareThink({ Think });
    await Promise.all(
      ["first", "second"].map((body) =>
        new Think()._runInferenceLoop({ body }),
      ),
    );
    expect(cloudflareThinkSpanCountForTesting()).toBe(2);
    starts.forEach((start) => start());
    for (const callId of ["second", "first"]) {
      telemetry.onLanguageModelCallStart({ callId });
      telemetry.onLanguageModelCallEnd({
        callId,
        text: callId,
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      });
      telemetry.onToolExecutionStart({
        callId,
        toolCall: { toolCallId: callId, toolName: "lookup", input: {} },
      });
      telemetry.onToolExecutionEnd({
        callId,
        toolCall: { toolCallId: callId, toolName: "lookup" },
        output: callId,
        success: true,
      });
      telemetry.onEnd({
        callId,
        operationId: "ai.streamText",
        text: callId,
        totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      });
    }
    const spans = (await backgroundLogger.drain()) as any[];
    expect(spans).toHaveLength(6);
    for (const callId of ["first", "second"]) {
      const task = spans.find(
        (span) =>
          span.span_attributes?.name === "Think.runTurn" &&
          span.input?.[0]?.content === callId,
      );
      expect(task).toMatchObject({
        output: { role: "assistant", content: callId },
        metadata: {
          braintrust: { integration_name: "cloudflare-think" },
          model: "think-model",
          provider: "think-provider",
        },
        metrics: { prompt_tokens: 3, completion_tokens: 4, tokens: 7 },
      });
      expect(
        spans.filter((span) => span.span_parents?.[0] === task.span_id),
      ).toHaveLength(2);
    }
  });

  it.each(["onError", "onAbort"])(
    "releases an AI SDK 7 turn after %s",
    async (end) => {
      const telemetry = braintrustAISDKTelemetry();
      class Think {
        async _runInferenceLoop() {
          telemetry.onStart({ callId: "failed", operationId: "ai.streamText" });
          telemetry.onLanguageModelCallStart({ callId: "failed" });
          return {};
        }
      }
      wrapCloudflareThink({ Think });
      await new Think()._runInferenceLoop();
      const error = new Error("interrupted");
      telemetry[end]({ callId: "failed", error });
      telemetry.onEnd({ callId: "failed", operationId: "ai.streamText" });
      const spans = (await backgroundLogger.drain()) as any[];
      expect(spans).toHaveLength(2);
      for (const span of spans) {
        expect(span.error).toContain("interrupted");
        expect(span.metrics.end).toEqual(expect.any(Number));
      }
    },
  );

  it("respects AI SDK 7 input and output recording controls", async () => {
    const telemetry = braintrustAISDKTelemetry();
    class Think {
      messages = [{ role: "user", content: "private fallback" }];

      async _runInferenceLoop() {
        telemetry.onStart({
          callId: "private",
          operationId: "ai.streamText",
          messages: this.messages,
          recordInputs: false,
          recordOutputs: false,
        });
        return {};
      }
    }
    wrapCloudflareThink({ Think });
    await new Think()._runInferenceLoop();
    telemetry.onEnd({
      callId: "private",
      operationId: "ai.streamText",
      text: "private output",
    });
    const spans = (await backgroundLogger.drain()) as any[];
    expect(spans).toHaveLength(1);
    expect(spans[0].input).toBeUndefined();
    expect(spans[0].output).toBeUndefined();
  });

  it.each(["disabled", "throws"] as const)(
    "does not wait for telemetry when the v7 invocation %s",
    async (mode) => {
      const error = new Error("invalid stream");
      class Think {
        async _runInferenceLoop() {
          try {
            return aiSDKChannels.streamTextV7.invoke(
              () => {
                if (mode === "throws") throw error;
                return {};
              },
              undefined,
              [{ telemetry: { isEnabled: mode !== "disabled" } }],
              {},
            );
          } catch (caught) {
            expect(caught).toBe(error);
            // A Think subclass may recover from a synchronous stream error.
            return {};
          }
        }
      }
      wrapCloudflareThink({ Think });
      await new Think()._runInferenceLoop();
      const spans = (await backgroundLogger.drain()) as any[];
      expect(spans).toHaveLength(1);
      expect(spans[0].metrics.end).toEqual(expect.any(Number));
    },
  );

  it("ends a v7 task when prompt validation fails before telemetry starts", async () => {
    const telemetry = braintrustAISDKTelemetry();
    let fail: () => void;
    class Think {
      async _runInferenceLoop() {
        return aiSDKChannels.streamTextV7.invoke(
          () => {
            const span = currentSpan();
            fail = () =>
              withCurrent(span, () =>
                telemetry.onError({
                  callId: "invalid",
                  error: new Error("invalid prompt"),
                }),
              );
            return {};
          },
          undefined,
          [{}],
          {},
        );
      }
    }
    wrapCloudflareThink({ Think });
    await new Think()._runInferenceLoop();
    expect(cloudflareThinkSpanCountForTesting()).toBe(1);
    fail!();
    const spans = (await backgroundLogger.drain()) as any[];
    expect(spans).toHaveLength(1);
    expect(spans[0].error).toContain("invalid prompt");
    expect(spans[0].metrics.end).toEqual(expect.any(Number));
  });

  it.each([
    { aisdk: true, explicit: false },
    { aisdk: false, explicit: false },
    { aisdk: true, explicit: true },
    { aisdk: false, explicit: true },
  ])(
    "traces v7 dispatchers once with aisdk=$aisdk and explicit=$explicit",
    async ({ aisdk, explicit }) => {
      resetInstrumentationForTest();
      registry.configure({ integrations: { aisdk } });
      registerAISDKInstrumentation();
      try {
        const explicitTelemetry = explicit
          ? braintrustAISDKTelemetry()
          : undefined;
        let dispatcher: any;
        class Think {
          async _runInferenceLoop() {
            return aiSDKChannels.streamTextV7.invoke(
              () => {
                dispatcher = aiSDKChannels.v7CreateTelemetryDispatcher.invoke(
                  () => ({ ...explicitTelemetry }),
                  undefined,
                  [
                    {
                      telemetry: explicitTelemetry
                        ? { integrations: [explicitTelemetry] }
                        : undefined,
                    },
                  ],
                  {},
                );
                dispatcher.onStart({
                  callId: "dispatcher",
                  operationId: "ai.streamText",
                  messages: [{ role: "user", content: "Hello" }],
                });
                return {};
              },
              undefined,
              [{}],
              {},
            );
          }
        }
        wrapCloudflareThink({ Think });
        await new Think()._runInferenceLoop();
        dispatcher.onLanguageModelCallStart({ callId: "dispatcher" });
        dispatcher.onLanguageModelCallEnd({
          callId: "dispatcher",
          text: "Hello",
        });
        dispatcher.onEnd({
          callId: "dispatcher",
          operationId: "ai.streamText",
          text: "Hello",
        });
        const spans = (await backgroundLogger.drain()) as any[];
        expect(spans).toHaveLength(2);
        expect(spans.map((span) => span.span_attributes.name).sort()).toEqual([
          "Think.runTurn",
          "doStream",
        ]);
      } finally {
        resetInstrumentationForTest();
        registry.configure({});
        registerAISDKInstrumentation();
      }
    },
  );
});

function makeStreamingModel(text: string): any {
  return {
    specificationVersion: "v3",
    provider: "think-provider",
    modelId: "think-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate should not be called");
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({ type: "text-delta", id: "text-1", delta: text });
          controller.enqueue({ type: "text-end", id: "text-1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 3,
                noCache: 3,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: {
                total: 4,
                text: 4,
                reasoning: 0,
              },
            },
          });
          controller.close();
        },
      }),
      warnings: [],
    }),
  };
}
