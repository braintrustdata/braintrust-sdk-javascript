/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { _exportsForTestingOnly } from "../logger/testing";
import { initLogger, traced, type TestBackgroundLogger } from "../logger/core";
import { configureNode } from "../node/config";
import { aiSDKChannels } from "../instrumentation/providers/ai-sdk-interceptors";
import { registerInstrumentation } from "../instrumentation/registrations/aisdk";
import { runWithAutoInstrumentationSuppressed } from "../instrumentation/auto-instrumentation-suppression";
import type {
  AISDKEvaluateParams,
  AISDKEvaluationResult,
} from "../vendor-sdk-types/ai-sdk";
import { wrapAISDK } from "./ai-sdk/ai-sdk";

configureNode();

const questions = {
  category: {
    type: "choice",
    instructions: "Which team should handle this request?",
    criteria: { billing: null, technical: null },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is this request?",
    criteria: ["Low", "High"],
  },
  duplicate: {
    type: "boolean",
    instructions: "Was there a duplicate charge?",
  },
};

const answers = {
  category: {
    type: "choice",
    choice: "billing",
    probabilities: { billing: 0.9, technical: 0.1 },
  },
  urgency: {
    type: "score",
    score: 0.75,
    probabilities: { 0: 0.25, 1: 0.75 },
  },
  duplicate: { type: "boolean", probability: 0.95 },
};

const params: AISDKEvaluateParams = {
  model: "typesafe-ai/jev",
  state: { message: "Charged twice" },
  questions,
};

const result: AISDKEvaluationResult = {
  answers,
  usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  response: { modelId: "typesafe-ai/jev-1.13.0" },
  providerMetadata: {
    gateway: {
      cost: 0.012,
      routing: {
        resolvedProvider: "typesafe",
        resolvedProviderApiModelId: "jev-1.13.0",
      },
    },
    typesafe: { confidence: { category: 0.9, urgency: 0.8 } },
  },
};

describe.each(["experimental_evaluate", "experimental_decide"] as const)(
  "AI SDK %s instrumentation",
  (method) => {
    let backgroundLogger: TestBackgroundLogger;

    beforeEach(async () => {
      await _exportsForTestingOnly.simulateLoginForTests();
      backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
      initLogger({
        projectName: "ai-sdk-evaluate.test.ts",
        projectId: "test-project-id",
      });
    });

    afterEach(() => {
      _exportsForTestingOnly.clearTestBackgroundLogger();
      vi.restoreAllMocks();
    });

    test("keeps media request, receiver, promise and result identity", async () => {
      vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "true");
      const bytes = new Uint8Array([1, 2]);
      const request = {
        ...params,
        state: [
          { type: "file", mediaType: "image/png", data: bytes },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: bytes },
          },
        ],
      };
      const promise = Promise.resolve(result);
      const provider = {
        [method]: vi.fn(function (this: unknown, actual) {
          expect(this).toBe(provider);
          expect(actual).toBe(request);
          expect(actual.state[0].data).toBe(bytes);
          expect(actual.state[1].data.data).toBe(bytes);
          return promise;
        }),
      };
      const wrapped = wrapAISDK(provider);
      try {
        expect(wrapped[method].call(provider, request)).toBe(promise);
        expect(await promise).toBe(result);
        bytes.fill(9);
        const [span] = await backgroundLogger.drain();
        expect("input" in span && span.input).toMatchObject({
          state: [
            { type: "file", data: "AQI=" },
            { type: "file", data: { type: "data", data: "AQI=" } },
          ],
        });
        expect(provider[method]).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    test("captures native answers, allowlisted metadata, usage, and parent context", async () => {
      const response = {
        ...result,
        providerMetadata: {
          ...result.providerMetadata,
          privateProvider: { secret: "not logged" },
        },
      };
      const original = Promise.resolve(response);
      const evaluate = vi.fn((_params: AISDKEvaluateParams) => original);
      const wrapped = wrapAISDK({ [method]: evaluate });
      await traced(
        async () => {
          const promise = wrapped[method](params);
          expect(promise).toBe(original);
          expect(await promise).toBe(response);
        },
        { name: "parent" },
      );

      expect(evaluate).toHaveBeenCalledExactlyOnceWith(params);
      const spans = (await backgroundLogger.drain()) as Record<string, any>[];
      expect(spans).toHaveLength(2);
      const parent = spans.find(
        (span) => span.span_attributes?.name === "parent",
      );
      const span = spans.find(
        (span) => span.span_attributes?.name === "evaluate",
      );
      expect(span).toMatchObject({
        span_attributes: { name: "evaluate", type: "question" },
        span_parents: [parent?.span_id],
        input: {
          state: params.state,
          questions: [
            { ...questions.category, id: "category" },
            { ...questions.urgency, id: "urgency" },
            { ...questions.duplicate, id: "duplicate" },
          ],
        },
        output: {
          answers: [
            {
              ...answers.category,
              confidence: 0.9,
              id: "category",
            },
            {
              ...answers.urgency,
              confidence: 0.8,
              id: "urgency",
            },
            { ...answers.duplicate, id: "duplicate" },
          ],
        },
        metadata: {
          model: "jev-1.13.0",
          provider: "typesafe",
          providerMetadata: {
            typesafe: result.providerMetadata?.typesafe,
          },
        },
        metrics: {
          prompt_tokens: 20,
          completion_tokens: 5,
          tokens: 25,
          estimated_cost: 0.012,
        },
      });
      expect(span?.metadata?.providerMetadata).not.toHaveProperty(
        "privateProvider",
      );
    });

    test("applies output filtering and span overrides without changing results", async () => {
      const evaluate = vi.fn(async (_params: AISDKEvaluateParams) => result);
      const wrapped = wrapAISDK(
        { [method]: evaluate },
        {
          denyOutputPaths: ["answers[].probabilities"],
        },
      );
      expect(
        await wrapped[method]({
          ...params,
          span_info: { name: "decision", metadata: { customer: "test" } },
        }),
      ).toBe(result);
      expect(evaluate.mock.calls[0][0]).not.toHaveProperty("span_info");
      const [span] = (await backgroundLogger.drain()) as Record<string, any>[];
      expect(span).toMatchObject({
        span_attributes: { name: "decision" },
        metadata: { customer: "test" },
      });
      expect(span.output.answers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "category",
            probabilities: "<omitted>",
          }),
        ]),
      );
      expect(answers.category).toHaveProperty("probabilities", {
        billing: 0.9,
        technical: 0.1,
      });
    });

    test("deduplicates nested wrappers and automatic hooks", async () => {
      const evaluate = vi.fn(async (_params: AISDKEvaluateParams) => result);
      const autoInstrumented = {
        [method]: (params: AISDKEvaluateParams) =>
          aiSDKChannels.evaluate.invoke(evaluate, undefined, [params], {}),
      };
      await wrapAISDK(wrapAISDK(autoInstrumented))[method](params);
      expect(evaluate).toHaveBeenCalledOnce();
      expect(await backgroundLogger.drain()).toHaveLength(1);
    });

    test("registers repeatedly without duplicate subscriptions", async () => {
      const original = Promise.resolve(result);
      const wrapped = wrapAISDK({
        [method]: (_params: AISDKEvaluateParams) => original,
      });
      registerInstrumentation();
      registerInstrumentation();
      await wrapped[method](params);
      expect(await backgroundLogger.drain()).toHaveLength(1);
    });

    test.each([false, true])(
      "preserves errors (synchronous: %s)",
      async (synchronous) => {
        const error = new Error("Evaluation failed");
        const evaluate = (_params: AISDKEvaluateParams) => {
          if (synchronous) throw error;
          return Promise.reject(error);
        };
        const wrapped = wrapAISDK({ [method]: evaluate });
        if (synchronous) {
          expect(() => wrapped[method](params)).toThrow(error);
        } else {
          await expect(wrapped[method](params)).rejects.toBe(error);
        }
        const [span] = (await backgroundLogger.drain()) as Record<
          string,
          any
        >[];
        expect(span.error).toContain("Evaluation failed");
        expect(span.metrics?.end).toEqual(expect.any(Number));
      },
    );

    test("omits unavailable usage and respects suppression", async () => {
      const wrapped = wrapAISDK({
        [method]: async (_params: AISDKEvaluateParams) => ({
          answers: {},
        }),
      });
      await wrapped[method]({
        ...params,
        model: { modelId: "custom", provider: "custom-provider" },
      });
      await runWithAutoInstrumentationSuppressed(() => wrapped[method](params));
      const spans = (await backgroundLogger.drain()) as Record<string, any>[];
      expect(spans).toHaveLength(1);
      expect(spans[0].metadata).toMatchObject({
        model: "custom",
        provider: "custom-provider",
      });
      expect(spans[0].metrics).not.toHaveProperty("tokens");
    });

    test("respects telemetry capture and disabling options", async () => {
      const evaluate = vi.fn(async (_params: AISDKEvaluateParams) => result);
      const wrapped = wrapAISDK({ [method]: evaluate });
      await wrapped[method]({ ...params, telemetry: { isEnabled: false } });
      expect(await backgroundLogger.drain()).toHaveLength(0);
      await wrapped[method]({
        ...params,
        telemetry: { recordInputs: false, recordOutputs: false },
      });
      const [span] = (await backgroundLogger.drain()) as Record<string, any>[];
      expect(span).not.toHaveProperty("input");
      expect(span).not.toHaveProperty("output");
      expect(span.metrics).toMatchObject({ tokens: 25 });
      expect(evaluate).toHaveBeenCalledTimes(2);
    });

    test("contains extraction failures and preserves older SDK namespaces", async () => {
      expect(
        wrapAISDK({ experimental_evaluate: undefined }).experimental_evaluate,
      ).toBeUndefined();
      const malformed = {
        get answers(): never {
          throw new Error("Unreadable answers");
        },
      };
      const wrapped = wrapAISDK({
        [method]: async (_params: AISDKEvaluateParams) => malformed,
      });
      expect(await wrapped[method](params)).toBe(malformed);
      const [span] = (await backgroundLogger.drain()) as Record<string, any>[];
      expect(span.metrics?.end).toEqual(expect.any(Number));
    });
  },
);
