import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

const { evalMock } = vi.hoisted(() => ({
  evalMock: vi.fn(),
}));

vi.mock("../framework", () => ({
  Eval: evalMock,
}));

import iso from "../isomorph";
import type {
  LangSmithEvaluate,
  LangSmithExample,
} from "../vendor-sdk-types/langsmith";
import {
  type BraintrustLangSmithEvalResult,
  wrapLangSmithEvaluate,
} from "./langsmith";

const braintrustResult = {
  results: [],
  summary: {
    experimentName: "braintrust-experiment",
    projectName: "braintrust-project",
    scores: {},
  },
} as unknown as BraintrustLangSmithEvalResult;

describe("wrapLangSmithEvaluate", () => {
  beforeEach(() => {
    evalMock.mockReset();
    evalMock.mockResolvedValue(braintrustResult);
    vi.spyOn(iso, "getEnv").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs standalone evals with converted data, targets, and evaluator results", async () => {
    const langSmithEvaluate = vi.fn();
    const onBraintrustResult = vi.fn();
    const example: LangSmithExample = {
      id: "example-1",
      inputs: { text: "hello" },
      outputs: { expectedLength: 5 },
      metadata: { category: "greeting" },
      attachments: {
        source: {
          mime_type: "text/plain",
          presigned_url: "https://example.com/source.txt",
        },
      },
    };
    let receivedEvaluatorArgs: Record<string, unknown> | undefined;
    const target = vi.fn(async (_input, config) => {
      expect(config).toEqual({ attachments: example.attachments });
      return "hello";
    });
    const evaluator = vi.fn((args) => {
      receivedEvaluatorArgs = args;
      return [
        { key: "correct", score: true, comment: "matched" },
        {
          key: "quality",
          score: 0.75,
          metadata: { rubric: "short-answer" },
        },
      ];
    });

    const evaluate = wrapLangSmithEvaluate(langSmithEvaluate, {
      onBraintrustResult,
      projectId: "project-id",
      projectName: "project-name",
      standalone: true,
    });
    const result = await evaluate(target, {
      data: [example],
      description: "description",
      evaluators: [evaluator],
      experimentPrefix: "experiment-prefix",
      includeAttachments: true,
      maxConcurrency: 3,
      metadata: { suite: "migration" },
      numRepetitions: 2,
    });

    expect(result).toBe(braintrustResult);
    expect(langSmithEvaluate).not.toHaveBeenCalled();
    expect(onBraintrustResult).toHaveBeenCalledWith(braintrustResult);
    expect(evalMock).toHaveBeenCalledWith(
      "project-name",
      expect.objectContaining({
        description: "description",
        experimentName: "experiment-prefix",
        maxConcurrency: 3,
        metadata: { suite: "migration" },
        projectId: "project-id",
        trialCount: 2,
      }),
    );

    const evaluatorDefinition = evalMock.mock.calls[0][1];
    const dataIterator = evaluatorDefinition.data[Symbol.asyncIterator]();
    const datum = (await dataIterator.next()).value;
    expect(datum).toEqual({
      expected: example,
      input: example.inputs,
      metadata: example.metadata,
    });

    const output = await evaluatorDefinition.task(datum.input, {
      expected: datum.expected,
    });
    const scores = await evaluatorDefinition.scores[0]({
      ...datum,
      output,
      trace: {
        getConfiguration: () => ({
          object_id: "experiment-id",
          root_span_id: "root-span-id",
        }),
      },
    });

    expect(target).toHaveBeenCalledWith(example.inputs, {
      attachments: example.attachments,
    });
    expect(receivedEvaluatorArgs).toMatchObject({
      attachments: example.attachments,
      example,
      id: "root-span-id",
      inputs: example.inputs,
      outputs: { outputs: "hello" },
      referenceOutputs: example.outputs,
      reference_example_id: example.id,
      run: {
        id: "root-span-id",
        session_id: "experiment-id",
        trace_id: "root-span-id",
      },
    });
    expect(scores).toEqual([
      {
        metadata: { comment: "matched" },
        name: "correct",
        score: 1,
      },
      {
        metadata: { metadata: { rubric: "short-answer" } },
        name: "quality",
        score: 0.75,
      },
    ]);
  });

  it("loads named datasets with a client and supports runnable and RunEvaluator objects", async () => {
    const example: LangSmithExample = {
      id: "example-2",
      inputs: { value: 2 },
      outputs: { value: 4 },
      attachments: {
        image: {
          mime_type: "image/png",
          presigned_url: "https://example.com/image.png",
        },
      },
    };
    const listExamples = vi.fn(async function* () {
      yield example;
    });
    const invoke = vi.fn(async () => ({ value: 4 }));
    const evaluateRun = vi.fn(() => ({
      key: "doubled",
      score: false,
      value: "needs review",
    }));
    const evaluate = wrapLangSmithEvaluate(vi.fn(), {
      client: { listExamples },
      standalone: true,
    });

    await evaluate(
      { invoke },
      {
        data: "dataset-name",
        evaluators: [{ evaluateRun }],
        includeAttachments: true,
      },
    );

    const evaluatorDefinition = evalMock.mock.calls[0][1];
    const datum = (
      await evaluatorDefinition.data[Symbol.asyncIterator]().next()
    ).value;
    const output = await evaluatorDefinition.task(datum.input, {
      expected: datum.expected,
    });
    const scores = await evaluatorDefinition.scores[0]({
      ...datum,
      output,
      trace: {
        getConfiguration: () => ({
          object_id: "experiment-id",
          root_span_id: "root-span-id",
        }),
      },
    });

    expect(listExamples).toHaveBeenCalledWith({
      datasetName: "dataset-name",
      includeAttachments: true,
    });
    expect(invoke).toHaveBeenCalledWith(example.inputs, {
      attachments: example.attachments,
    });
    expect(evaluateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: example.inputs,
        outputs: { value: 4 },
        reference_example_id: example.id,
      }),
      example,
    );
    expect(scores).toEqual([
      {
        metadata: { value: "needs review" },
        name: "doubled",
        score: 0,
      },
    ]);
  });

  it("buffers async data once and starts both tandem evaluations", async () => {
    let iterations = 0;
    const data = {
      async *[Symbol.asyncIterator]() {
        iterations += 1;
        yield { inputs: { value: 1 }, outputs: { value: 2 } };
      },
    };
    const langSmithResult = { experimentName: "langsmith-experiment" };
    let resolveLangSmith!: (value: typeof langSmithResult) => void;
    let resolveBraintrust!: (value: BraintrustLangSmithEvalResult) => void;
    const langSmithPromise = new Promise<typeof langSmithResult>((resolve) => {
      resolveLangSmith = resolve;
    });
    const braintrustPromise = new Promise<BraintrustLangSmithEvalResult>(
      (resolve) => {
        resolveBraintrust = resolve;
      },
    );
    const langSmithEvaluate = vi.fn<LangSmithEvaluate<typeof langSmithResult>>(
      () => langSmithPromise,
    );
    evalMock.mockReturnValue(braintrustPromise);
    const onBraintrustResult = vi.fn();
    const evaluate = wrapLangSmithEvaluate(langSmithEvaluate, {
      onBraintrustResult,
      standalone: false,
    });

    const resultPromise = evaluate(async () => ({}), {
      data,
      evaluators: [() => ({ key: "score", score: 1 })],
    });
    await vi.waitFor(() => {
      expect(langSmithEvaluate).toHaveBeenCalledTimes(1);
      expect(evalMock).toHaveBeenCalledTimes(1);
    });

    expect(iterations).toBe(1);
    expect(langSmithEvaluate.mock.calls[0][1].data).toEqual([
      { inputs: { value: 1 }, outputs: { value: 2 } },
    ]);

    resolveBraintrust(braintrustResult);
    resolveLangSmith(langSmithResult);
    await expect(resultPromise).resolves.toBe(langSmithResult);
    expect(onBraintrustResult).toHaveBeenCalledWith(braintrustResult);
  });

  it("contains Braintrust failures in tandem mode and preserves LangSmith failures", async () => {
    const braintrustError = new Error("Braintrust failed");
    const langSmithError = new Error("LangSmith failed");
    const onBraintrustError = vi.fn(async () => {
      throw new Error("callback failed");
    });
    evalMock.mockRejectedValueOnce(braintrustError);
    const successfulEvaluate = wrapLangSmithEvaluate(
      vi.fn(async () => "langsmith-result"),
      { onBraintrustError, standalone: false },
    );

    await expect(
      successfulEvaluate(async () => ({}), {
        data: [{ inputs: {} }],
        evaluators: [() => ({ key: "score", score: 1 })],
      }),
    ).resolves.toBe("langsmith-result");
    expect(onBraintrustError).toHaveBeenCalledWith(braintrustError);

    evalMock.mockResolvedValueOnce(braintrustResult);
    const failingEvaluate = wrapLangSmithEvaluate(
      vi.fn(async () => {
        throw langSmithError;
      }),
      { standalone: false },
    );
    await expect(
      failingEvaluate(async () => ({}), {
        data: [{ inputs: {} }],
        evaluators: [() => ({ key: "score", score: 1 })],
      }),
    ).rejects.toBe(langSmithError);

    const resultCallbackError = new Error("result callback failed");
    const callbackErrorHandler = vi.fn();
    evalMock.mockResolvedValueOnce(braintrustResult);
    const callbackEvaluate = wrapLangSmithEvaluate(
      vi.fn(async () => "langsmith-result"),
      {
        onBraintrustError: callbackErrorHandler,
        onBraintrustResult: async () => {
          throw resultCallbackError;
        },
        standalone: false,
      },
    );
    await expect(
      callbackEvaluate(async () => ({}), {
        data: [{ inputs: {} }],
        evaluators: [() => ({ key: "score", score: 1 })],
      }),
    ).resolves.toBe("langsmith-result");
    expect(callbackErrorHandler).toHaveBeenCalledWith(resultCallbackError);
  });

  it("uses environment defaults and maps matching split concurrency", async () => {
    vi.mocked(iso.getEnv).mockImplementation((name) => {
      const values: Record<string, string> = {
        BRAINTRUST_STANDALONE: "1",
        LANGCHAIN_PROJECT: "legacy-project",
        LANGSMITH_PROJECT: "langsmith-project",
      };
      return values[name];
    });
    const langSmithEvaluate = vi.fn();
    const evaluate = wrapLangSmithEvaluate(langSmithEvaluate);

    await evaluate(async () => ({}), {
      data: [{ inputs: {} }],
      evaluationConcurrency: 4,
      evaluators: [() => ({ key: "score", score: 1 })],
      targetConcurrency: 4,
    });

    expect(langSmithEvaluate).not.toHaveBeenCalled();
    expect(evalMock).toHaveBeenCalledWith(
      "langsmith-project",
      expect.objectContaining({ maxConcurrency: 4 }),
    );
  });

  it.each([
    {
      error: "comparative evaluations",
      options: { data: [{ inputs: {} }], evaluators: [vi.fn()] },
      target: [],
    },
    {
      error: "summary evaluators",
      options: {
        data: [{ inputs: {} }],
        evaluators: [vi.fn()],
        summaryEvaluators: [vi.fn()],
      },
      target: vi.fn(),
    },
    {
      error: "at least one row evaluator",
      options: { data: [{ inputs: {} }] },
      target: vi.fn(),
    },
    {
      error: "one concurrency limit",
      options: {
        data: [{ inputs: {} }],
        evaluationConcurrency: 2,
        evaluators: [vi.fn()],
        targetConcurrency: 1,
      },
      target: vi.fn(),
    },
    {
      error: "LangSmith client is required",
      options: { data: "dataset-name", evaluators: [vi.fn()] },
      target: vi.fn(),
    },
  ])(
    "rejects unsupported calls: $error",
    async ({ error, options, target }) => {
      const langSmithEvaluate = vi.fn();
      const evaluate = wrapLangSmithEvaluate(langSmithEvaluate, {
        standalone: false,
      });

      await expect(evaluate(target as never, options as never)).rejects.toThrow(
        error,
      );
      expect(langSmithEvaluate).not.toHaveBeenCalled();
      expect(evalMock).not.toHaveBeenCalled();
    },
  );

  it("is idempotent and exposes mode-specific return types", () => {
    const original = vi.fn(async () => ({ experimentName: "langsmith" }));
    const tandem = wrapLangSmithEvaluate(original, { standalone: false });
    const standalone = wrapLangSmithEvaluate(original, { standalone: true });
    const environmentConfigured = wrapLangSmithEvaluate(original);

    expect(wrapLangSmithEvaluate(tandem, { standalone: false })).toBe(tandem);
    expectTypeOf(tandem).returns.resolves.toEqualTypeOf<{
      experimentName: string;
    }>();
    expectTypeOf(
      standalone,
    ).returns.resolves.toEqualTypeOf<BraintrustLangSmithEvalResult>();
    expectTypeOf(environmentConfigured).returns.resolves.toEqualTypeOf<
      { experimentName: string } | BraintrustLangSmithEvalResult
    >();
  });

  it("rejects invalid evaluate functions synchronously", () => {
    expect(() => wrapLangSmithEvaluate(null as never)).toThrow(
      "Expected LangSmith evaluate to be a function",
    );
  });

  it("accepts the structural LangSmith evaluate type", () => {
    const evaluate: LangSmithEvaluate<{
      experimentName: string;
    }> = async () => ({ experimentName: "langsmith" });

    expectTypeOf(
      wrapLangSmithEvaluate(evaluate, { standalone: false }),
    ).toEqualTypeOf(evaluate);
  });
});
