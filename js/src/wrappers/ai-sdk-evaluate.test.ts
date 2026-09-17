/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _exportsForTestingOnly,
  initLogger,
  traced,
  type TestBackgroundLogger,
} from "../logger";
import { configureNode } from "../node/config";
import { aiSDKChannels } from "../instrumentation/plugins/ai-sdk-channels";
import { registry } from "../instrumentation/registry";
import { runWithAutoInstrumentationSuppressed } from "../instrumentation/auto-instrumentation-suppression";
import type {
  AISDKEvaluateParams,
  AISDKEvaluationResult,
} from "../vendor-sdk-types/ai-sdk";
import { wrapAISDK } from "./ai-sdk/ai-sdk";

configureNode();

const params: AISDKEvaluateParams = {
  model: "typesafe-ai/jev",
  state: { message: "Charged twice" },
  questions: {
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
  },
};

const result: AISDKEvaluationResult = {
  answers: {
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
  },
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

describe("AI SDK evaluate instrumentation", () => {
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
    const wrapped = wrapAISDK({ experimental_evaluate: evaluate });
    await traced(
      async () => {
        const promise = wrapped.experimental_evaluate(params);
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
          { ...params.questions.category, id: "category" },
          { ...params.questions.urgency, id: "urgency" },
          { ...params.questions.duplicate, id: "duplicate" },
        ],
      },
      output: {
        answers: [
          {
            ...result.answers.category,
            confidence: 0.9,
            id: "category",
          },
          {
            ...result.answers.urgency,
            confidence: 0.8,
            id: "urgency",
          },
          { ...result.answers.duplicate, id: "duplicate" },
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
      { experimental_evaluate: evaluate },
      {
        denyOutputPaths: ["answers[].probabilities"],
      },
    );
    expect(
      await wrapped.experimental_evaluate({
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
    expect(result.answers.category).toHaveProperty("probabilities", {
      billing: 0.9,
      technical: 0.1,
    });
  });

  test("deduplicates nested wrappers and automatic hooks", async () => {
    const evaluate = vi.fn(async (_params: AISDKEvaluateParams) => result);
    const autoInstrumented = {
      experimental_evaluate: (params: AISDKEvaluateParams) =>
        aiSDKChannels.evaluate.invoke(evaluate, undefined, [params], {}),
    };
    await wrapAISDK(wrapAISDK(autoInstrumented)).experimental_evaluate(params);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(await backgroundLogger.drain()).toHaveLength(1);
  });

  test("preserves calls while disabled and resumes without duplicate subscriptions", async () => {
    const original = Promise.resolve(result);
    const wrapped = wrapAISDK({
      experimental_evaluate: (_params: AISDKEvaluateParams) => original,
    });
    registry.disable();
    registry.disable();
    try {
      expect(wrapped.experimental_evaluate(params)).toBe(original);
      await original;
      expect(await backgroundLogger.drain()).toHaveLength(0);
    } finally {
      registry.enable();
      registry.enable();
    }
    await wrapped.experimental_evaluate(params);
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
      const wrapped = wrapAISDK({ experimental_evaluate: evaluate });
      if (synchronous) {
        expect(() => wrapped.experimental_evaluate(params)).toThrow(error);
      } else {
        await expect(wrapped.experimental_evaluate(params)).rejects.toBe(error);
      }
      const [span] = (await backgroundLogger.drain()) as Record<string, any>[];
      expect(span.error).toContain("Evaluation failed");
      expect(span.metrics?.end).toEqual(expect.any(Number));
    },
  );

  test("omits unavailable usage and respects suppression", async () => {
    const wrapped = wrapAISDK({
      experimental_evaluate: async (_params: AISDKEvaluateParams) => ({
        answers: {},
      }),
    });
    await wrapped.experimental_evaluate({
      ...params,
      model: { modelId: "custom", provider: "custom-provider" },
    });
    await runWithAutoInstrumentationSuppressed(() =>
      wrapped.experimental_evaluate(params),
    );
    const spans = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(spans).toHaveLength(1);
    expect(spans[0].metadata).toMatchObject({
      model: "custom",
      provider: "custom-provider",
    });
    expect(spans[0].metrics).not.toHaveProperty("tokens");
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
      experimental_evaluate: async (_params: AISDKEvaluateParams) => malformed,
    });
    expect(await wrapped.experimental_evaluate(params)).toBe(malformed);
    const [span] = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(span.metrics?.end).toEqual(expect.any(Number));
  });
});
