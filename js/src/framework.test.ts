import {
  beforeAll,
  expect,
  describe,
  test,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  defaultErrorScoreHandler,
  Eval,
  EvalScorer,
  runEvaluator,
} from "./framework";
import { _exportsForTestingOnly, BraintrustState } from "./logger";
import { configureNode } from "./node/config";
import type { ProgressReporter } from "./reporters/types";
import { InternalAbortError } from "./util";

beforeAll(() => {
  configureNode();
});

class NoopProgressReporter implements ProgressReporter {
  public start() {}
  public stop() {}
  public increment() {}
}

test("meta (write) is passed to task", async () => {
  const metadata = {
    bar: "baz",
    foo: "bar",
  };

  const out = await runEvaluator(
    null,
    {
      projectName: "proj",
      evalName: "eval",
      data: [{ input: 1, metadata }],
      task: async (input: number, { meta }) => {
        meta({
          foo: "barbar",
        });
        return input * 2;
      },
      scores: [],
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  // @ts-expect-error metadata is not typed if the experiment is missing
  expect(out.results[0].metadata).toEqual({
    bar: "baz",
    foo: "barbar",
  });
});

test("metadata (read/write) is passed to task", async () => {
  const metadata = {
    bar: "baz",
    foo: "bar",
  };

  let passedIn: Record<string, unknown> | null = null;

  const out = await runEvaluator(
    null,
    {
      projectName: "proj",
      evalName: "eval",
      data: [{ input: 1, metadata }],
      task: async (input: number, { metadata: m }) => {
        passedIn = { ...m };

        // modify the metadata object
        m.foo = "barbar";

        return input * 2;
      },
      scores: [],
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(passedIn).toEqual(metadata);

  // @ts-expect-error metadata is not typed if the experiment is missing
  expect(out.results[0].metadata).toEqual({
    bar: "baz",
    foo: "barbar",
  });
});

test("expected (read/write) is passed to task", async () => {
  const expected = {
    bar: "baz",
    foo: "bar",
  };

  let passedIn: Record<string, unknown> | null = null;

  const out = await runEvaluator(
    null,
    {
      projectName: "proj",
      evalName: "eval",
      data: [{ input: 1, expected }],
      task: async (input: number, { expected: e }) => {
        passedIn = { ...e };

        // modify the expected object
        e.foo = "barbar";

        return input * 2;
      },
      scores: [],
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(passedIn).toEqual({
    bar: "baz",
    foo: "bar",
  });

  // @ts-expect-error metadata is not typed if the experiment is missing
  expect(out.results[0].expected).toEqual({
    bar: "baz",
    foo: "barbar",
  });
});

function makeTestScorer(
  name: string,
  willError?: boolean,
): EvalScorer<any, any, any, any> {
  return () => {
    if (willError) {
      throw new Error("scorer errored");
    }
    return {
      name,
      score: 1,
    };
  };
}

describe("runEvaluator", () => {
  describe("errors", () => {
    test("task errors generate no scores", async () => {
      const out = await runEvaluator(
        null,
        {
          projectName: "proj",
          evalName: "eval",
          data: [{ input: 1 }],
          task: async () => {
            throw new Error("test error");
          },
          scores: Array.from({ length: 3 }, (_, i) =>
            makeTestScorer(`scorer_${i}`),
          ),
        },
        new NoopProgressReporter(),
        [],
        undefined,
        true,
      );

      expect(out.results.every((r) => Object.keys(r.scores).length === 0)).toBe(
        true,
      );
    });

    describe("errorScoreHandler", () => {
      describe("default function", () => {
        test("task errors generate 0 scores for all scorers", async () => {
          const out = await runEvaluator(
            null,
            {
              projectName: "proj",
              evalName: "eval",
              data: [{ input: 1 }],
              task: async () => {
                throw new Error("test error");
              },
              scores: Array.from({ length: 3 }, (_, i) =>
                makeTestScorer(`scorer_${i}`),
              ),
              errorScoreHandler: defaultErrorScoreHandler,
            },
            new NoopProgressReporter(),
            [],
            undefined,
            true,
          );

          expect(
            out.results.every(
              (r) =>
                Object.keys(r.scores).length === 3 &&
                Object.values(r.scores).every((v) => v === 0),
            ),
          ).toBe(true);
        });

        test("scorer errors generate 0 scores for all errored scorers", async () => {
          const out = await runEvaluator(
            null,
            {
              projectName: "proj",
              evalName: "eval",
              data: [{ input: 1 }],
              task: async () => {
                return "valid output";
              },
              scores: Array.from({ length: 3 }, (_, i) =>
                makeTestScorer(`scorer_${i}`, i === 0),
              ),
              errorScoreHandler: defaultErrorScoreHandler,
            },
            new NoopProgressReporter(),
            [],
            undefined,
            true,
          );

          expect(
            out.results.every(
              (r) =>
                Object.keys(r.scores).length === 3 &&
                r.scores.scorer_0 === 0 &&
                r.scores.scorer_1 === 1 &&
                r.scores.scorer_2 === 1,
            ),
          ).toBe(true);
        });
      });

      describe("custom function", () => {
        test("noop function generates no scores", async () => {
          const out = await runEvaluator(
            null,
            {
              projectName: "proj",
              evalName: "eval",
              data: [{ input: 1 }],
              task: async () => {
                throw new Error("test error");
              },
              scores: Array.from({ length: 3 }, (_, i) =>
                makeTestScorer(`scorer_${i}`),
              ),
              errorScoreHandler: () => undefined,
            },
            new NoopProgressReporter(),
            [],
            undefined,
            true,
          );

          expect(
            out.results.every((r) => Object.keys(r.scores).length === 0),
          ).toBe(true);
        });

        test("function can generate arbitrary scores", async () => {
          const out = await runEvaluator(
            null,
            {
              projectName: "proj",
              evalName: "eval",
              data: [{ input: 1 }],
              task: async () => {
                throw new Error("test error");
              },
              scores: Array.from({ length: 3 }, (_, i) =>
                makeTestScorer(`scorer_${i}`),
              ),
              errorScoreHandler: () => ({ error_score: 1 }),
            },
            new NoopProgressReporter(),
            [],
            undefined,
            true,
          );

          expect(
            out.results.every(
              (r) =>
                Object.keys(r.scores).length === 1 &&
                r.scores.error_score === 1,
            ),
          ).toBe(true);
        });
      });
    });
  });

  describe("aborts", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    test("runEvaluator rejects on timeout and kills remaining tasks", async () => {
      const taskStarts: Set<number> = new Set();
      const taskCompletions: Set<number> = new Set();

      const runExpect = expect(
        runEvaluator(
          null,
          {
            projectName: "proj",
            evalName: "eval",
            data: Array.from({ length: 10 }, (_, i) => ({
              input: i,
              expected: i * 2,
            })),
            task: async (input: number) => {
              taskStarts.add(input);
              if (input > 2) {
                await new Promise((r) => setTimeout(r, 100));
              }
              taskCompletions.add(input);
              return input * 2;
            },
            scores: [],
            timeout: 10,
            maxConcurrency: 1,
          },
          new NoopProgressReporter(),
          [],
          undefined,
        ),
      ).rejects.toThrow(new InternalAbortError("Evaluator timed out"));

      await vi.advanceTimersByTimeAsync(10);
      await runExpect;

      // first 3 tasks complete and 4th task was started but not completed before timeout
      expect(taskStarts).toEqual(new Set([0, 1, 2, 3]));
      expect(taskCompletions).toEqual(new Set([0, 1, 2]));

      await vi.advanceTimersByTimeAsync(200);

      // no other tasks are started after evaluator is aborted and the 4th in-flight task completes
      expect(taskStarts).toEqual(new Set([0, 1, 2, 3]));
      expect(taskCompletions).toEqual(new Set([0, 1, 2, 3]));
      expect(vi.getTimerCount()).toBe(0);
    });

    test("runEvaluator rejects on abort signal and kills remaining tasks", async () => {
      const taskStarts: Set<number> = new Set();
      const taskCompletions: Set<number> = new Set();

      const abortController = new AbortController();

      const runExpect = expect(
        runEvaluator(
          null,
          {
            projectName: "proj",
            evalName: "eval",
            data: Array.from({ length: 10 }, (_, i) => ({
              input: i,
              expected: i * 2,
            })),
            task: async (input: number) => {
              taskStarts.add(input);
              if (input > 2) {
                await new Promise((r) => setTimeout(r, 100));
              }
              taskCompletions.add(input);
              return input * 2;
            },
            scores: [],
            signal: abortController.signal,
            maxConcurrency: 1,
          },
          new NoopProgressReporter(),
          [],
          undefined,
        ),
      ).rejects.toThrow(new InternalAbortError("Evaluator aborted"));

      await vi.advanceTimersByTimeAsync(10);
      abortController.abort();
      await runExpect;

      // first 3 tasks complete and 4th task was started but not completed before abort
      expect(taskStarts).toEqual(new Set([0, 1, 2, 3]));
      expect(taskCompletions).toEqual(new Set([0, 1, 2]));

      await vi.advanceTimersByTimeAsync(200);

      // no other tasks are started after evaluator is aborted and the 4th in-flight task completes
      expect(taskStarts).toEqual(new Set([0, 1, 2, 3]));
      expect(taskCompletions).toEqual(new Set([0, 1, 2, 3]));
      expect(vi.getTimerCount()).toBe(0);
    });

    test("runEvaluator works with no timeout or abort signal", async () => {
      const run = runEvaluator(
        null,
        {
          projectName: "proj",
          evalName: "eval",
          data: [{ input: 1, expected: 2 }],
          task: async (input: number) => {
            await new Promise((r) => setTimeout(r, 100));
            return input * 2;
          },
          scores: [],
        },
        new NoopProgressReporter(),
        [],
        undefined,
      );

      await vi.advanceTimersByTimeAsync(100);
      await run;
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

test("trialIndex is passed to task", async () => {
  const trialIndices: number[] = [];

  const { results } = await runEvaluator(
    null,
    {
      projectName: "proj",
      evalName: "eval",
      data: [{ input: 1, expected: 2 }],
      task: async (input: number, { trialIndex }) => {
        trialIndices.push(trialIndex);
        return input * 2;
      },
      scores: [],
      trialCount: 3,
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  // Should have 3 results (one for each trial)
  expect(results).toHaveLength(3);

  // Should have captured 3 trial indices
  expect(trialIndices).toHaveLength(3);
  expect(trialIndices.sort()).toEqual([0, 1, 2]);

  // All results should be correct
  results.forEach((result) => {
    expect(result.input).toBe(1);
    expect(result.expected).toBe(2);
    expect(result.output).toBe(2);
    expect(result.error).toBeUndefined();
  });
});

test("trialIndex with multiple inputs", async () => {
  const trialData: Array<{ input: number; trialIndex: number }> = [];

  const { results } = await runEvaluator(
    null,
    {
      projectName: "proj",
      evalName: "eval",
      data: [
        { input: 1, expected: 2 },
        { input: 2, expected: 4 },
      ],
      task: async (input: number, { trialIndex }) => {
        trialData.push({ input, trialIndex });
        return input * 2;
      },
      scores: [],
      trialCount: 2,
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  // Should have 4 results total (2 inputs × 2 trials)
  expect(results).toHaveLength(4);
  expect(trialData).toHaveLength(4);

  // Group by input to verify trial indices
  const input1Trials = trialData
    .filter((d) => d.input === 1)
    .map((d) => d.trialIndex)
    .sort();
  const input2Trials = trialData
    .filter((d) => d.input === 2)
    .map((d) => d.trialIndex)
    .sort();

  // Each input should have been run with trial indices 0 and 1
  expect(input1Trials).toEqual([0, 1]);
  expect(input2Trials).toEqual([0, 1]);
});

test("per-input trialCount overrides global trialCount", async () => {
  const trialData: Array<{ input: number; trialIndex: number }> = [];

  const { results } = await runEvaluator(
    null,
    {
      projectName: "proj",
      evalName: "eval",
      data: [
        { input: 1, expected: 2 },
        { input: 2, expected: 4, trialCount: 5 },
        { input: 3, expected: 6, trialCount: 1 },
      ],
      task: async (input: number, { trialIndex }) => {
        trialData.push({ input, trialIndex });
        return input * 2;
      },
      scores: [],
      trialCount: 2,
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(results).toHaveLength(8);
  expect(trialData).toHaveLength(8);

  // Input 1: should use global trialCount (2 trials)
  const input1Trials = trialData
    .filter((d) => d.input === 1)
    .map((d) => d.trialIndex)
    .sort();
  expect(input1Trials).toEqual([0, 1]);

  // Input 2: should use per-input trialCount (5 trials)
  const input2Trials = trialData
    .filter((d) => d.input === 2)
    .map((d) => d.trialIndex)
    .sort();
  expect(input2Trials).toEqual([0, 1, 2, 3, 4]);

  // Input 3: should use per-input trialCount (1 trial)
  const input3Trials = trialData
    .filter((d) => d.input === 3)
    .map((d) => d.trialIndex)
    .sort();
  expect(input3Trials).toEqual([0]);
});

test("per-input trialCount works without global trialCount", async () => {
  const trialData: Array<{ input: number; trialIndex: number }> = [];

  const { results } = await runEvaluator(
    null,
    {
      projectName: "proj",
      evalName: "eval",
      data: [
        { input: 1, expected: 2 },
        { input: 2, expected: 4, trialCount: 3 },
      ],
      task: async (input: number, { trialIndex }) => {
        trialData.push({ input, trialIndex });
        return input * 2;
      },
      scores: [],
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(results).toHaveLength(4);
  expect(trialData).toHaveLength(4);

  const input1Trials = trialData
    .filter((d) => d.input === 1)
    .map((d) => d.trialIndex)
    .sort();
  expect(input1Trials).toEqual([0]);

  const input2Trials = trialData
    .filter((d) => d.input === 2)
    .map((d) => d.trialIndex)
    .sort();
  expect(input2Trials).toEqual([0, 1, 2]);
});

test("Eval with noSendLogs: true runs locally without creating experiment", async () => {
  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();

  const result = await Eval(
    "test-no-logs",
    {
      data: () => [
        { input: "hello", expected: "hello world" },
        { input: "test", expected: "test world" },
      ],
      task: (input) => input + " world",
      scores: [
        (args) => ({
          name: "exact_match",
          score: args.output === args.expected ? 1 : 0,
        }),
        () => ({ name: "simple_scorer", score: 0.8 }),
      ],
    },
    { noSendLogs: true, returnResults: true },
  );

  // Verify it returns results
  expect(result.results).toHaveLength(2);
  expect(result.results[0].input).toBe("hello");
  expect(result.results[0].output).toBe("hello world");
  expect(result.results[0].scores.exact_match).toBe(1);
  expect(result.results[0].scores.simple_scorer).toBe(0.8);

  expect(result.results[1].input).toBe("test");
  expect(result.results[1].output).toBe("test world");
  expect(result.results[1].scores.exact_match).toBe(1);
  expect(result.results[1].scores.simple_scorer).toBe(0.8);

  // Verify it builds a local summary (no experimentUrl means local run)
  expect(result.summary.projectName).toBe("test-no-logs");
  expect(result.summary.experimentUrl).toBeUndefined();
  expect(result.summary.scores.exact_match.score).toBe(1);
  expect(result.summary.scores.simple_scorer.score).toBe(0.8);

  // Most importantly: verify that no logs were sent
  await memoryLogger.flush();
  expect(await memoryLogger.drain()).toHaveLength(0);
});

test("Eval with returnResults: false produces empty results but valid summary", async () => {
  const result = await Eval(
    "test-no-results",
    {
      projectName: "test-no-results-project",
      data: [
        { input: "hello", expected: "hello world" },
        { input: "test", expected: "test world" },
        { input: "foo", expected: "foo bar" },
      ],
      task: (input) => input + " world",
      scores: [
        (args) => ({
          name: "exact_match",
          score: args.output === args.expected ? 1 : 0,
        }),
        () => ({ name: "length_score", score: 0.75 }),
        () => ({ name: "quality_score", score: 0.9 }),
      ],
    },
    { noSendLogs: true, returnResults: false },
  );

  // Verify that results array is empty (memory not retained)
  expect(result.results).toHaveLength(0);

  // Verify that summary still has accurate aggregate scores
  expect(result.summary.projectName).toBe("test-no-results-project");
  expect(result.summary.experimentUrl).toBeUndefined();

  // exact_match: 2 out of 3 match = 2/3 ≈ 0.6667
  expect(result.summary.scores.exact_match.score).toBeCloseTo(2 / 3, 4);

  // length_score: always 0.75, so average is 0.75
  expect(result.summary.scores.length_score.score).toBe(0.75);

  // quality_score: always 0.9, so average is 0.9
  expect(result.summary.scores.quality_score.score).toBe(0.9);
});

test("Eval with returnResults: true collects all results", async () => {
  const result = await Eval(
    "test-with-results",
    {
      projectName: "test-with-results-project",
      data: [
        { input: "hello", expected: "hello world" },
        { input: "test", expected: "test world" },
      ],
      task: (input) => input + " world",
      scores: [
        (args) => ({
          name: "exact_match",
          score: args.output === args.expected ? 1 : 0,
        }),
      ],
    },
    { noSendLogs: true, returnResults: true },
  );

  // Verify that results are collected
  expect(result.results).toHaveLength(2);
  expect(result.results[0].input).toBe("hello");
  expect(result.results[0].output).toBe("hello world");
  expect(result.results[0].scores.exact_match).toBe(1);
  expect(result.results[1].input).toBe("test");
  expect(result.results[1].output).toBe("test world");
  expect(result.results[1].scores.exact_match).toBe(1);

  // Summary should also be correct
  expect(result.summary.scores.exact_match.score).toBe(1);
});

test("tags can be appended and logged to root span", async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  const experiment =
    _exportsForTestingOnly.initTestExperiment("js-tags-append");

  const initialTags = ["cookies n cream"];
  const appendedTags = ["chocolate", "vanilla", "strawberry"];
  const expectedTags = [
    "cookies n cream",
    "chocolate",
    "vanilla",
    "strawberry",
  ];

  const result = await runEvaluator(
    experiment,
    {
      projectName: "proj",
      evalName: "js-tags-append",
      data: [{ input: "hello", expected: "hello world", tags: initialTags }],
      task: (input, hooks) => {
        for (const t of appendedTags) hooks.tags.push(t);
        return input;
      },
      scores: [() => ({ name: "simple_scorer", score: 0.8 })],
      summarizeScores: false,
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );
  expect(result.results[0].tags).toEqual(expectedTags);

  await memoryLogger.flush();
  const logs = await memoryLogger.drain();
  const rootSpans = logs.filter((l: any) => !l["span_parents"]);
  expect(rootSpans).toHaveLength(1);
  expect((rootSpans[0] as any).tags).toEqual(expectedTags);
});

test.each([
  {
    title: "undefined list returns undefined for tags",
    providedTags: undefined,
    expectedTags: undefined,
  },
  {
    title: "empty list returns undefined for tags",
    providedTags: [],
    expectedTags: undefined,
  },
  {
    title: "tags can be set to a list",
    providedTags: ["chocolate", "vanilla", "strawberry"],
    expectedTags: ["chocolate", "vanilla", "strawberry"],
  },
])("$title", async ({ providedTags, expectedTags }) => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  const experiment = _exportsForTestingOnly.initTestExperiment("js-tags-list");

  const result = await runEvaluator(
    experiment,
    {
      projectName: "proj",
      evalName: "js-tags-list",
      data: [{ input: "hello", expected: "hello world" }],
      task: (input, hooks) => {
        hooks.tags = providedTags;
        return input;
      },
      scores: [() => ({ name: "simple_scorer", score: 0.8 })],
      summarizeScores: false,
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );
  expect(result.results[0].tags).toEqual(expectedTags);

  await memoryLogger.flush();
  const logs = await memoryLogger.drain();
  const rootSpans = logs.filter((l: any) => !l["span_parents"]);
  expect(rootSpans).toHaveLength(1);
  expect((rootSpans[0] as any).tags).toEqual(expectedTags);
});

test("tags are persisted with a failing scorer", async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  const experiment = _exportsForTestingOnly.initTestExperiment("js-tags-list");

  const expectedTags = ["chocolate", "vanilla", "strawberry"];

  const result = await runEvaluator(
    experiment,
    {
      projectName: "proj",
      evalName: "js-tags-list",
      data: [{ input: "hello", expected: "hello world" }],
      task: (input, hooks) => {
        hooks.tags = expectedTags;
        return input;
      },
      scores: [
        () => ({ name: "simple_scorer", score: 0.8 }),
        () => {
          throw new Error("test error");
        },
      ],
      summarizeScores: false,
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );
  expect(result.results[0].tags).toEqual(expectedTags);

  await memoryLogger.flush();
  const logs = await memoryLogger.drain();
  const rootSpans = logs.filter((l: any) => !l["span_parents"]);
  expect(rootSpans).toHaveLength(1);
  expect((rootSpans[0] as any).tags).toEqual(expectedTags);
});

test("tags remain empty when not set", async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  const experiment =
    _exportsForTestingOnly.initTestExperiment("js-tags-append");

  const result = await runEvaluator(
    experiment,
    {
      projectName: "proj",
      evalName: "js-tags-append",
      data: [{ input: "hello", expected: "hello world" }],
      task: (input, hooks) => {
        return input;
      },
      scores: [() => ({ name: "simple_scorer", score: 0.8 })],
      summarizeScores: false,
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );
  expect(result.results[0].tags).toEqual(undefined);

  await memoryLogger.flush();
  const logs = await memoryLogger.drain();
  const rootSpans = logs.filter((l: any) => !l["span_parents"]);
  expect(rootSpans).toHaveLength(1);
  expect((rootSpans[0] as any).tags).toEqual(undefined);
});

test("scorer spans have purpose='scorer' attribute", async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  const experiment =
    _exportsForTestingOnly.initTestExperiment("js-scorer-purpose");

  const result = await runEvaluator(
    experiment,
    {
      projectName: "test-scorer-purpose",
      evalName: "scorer-purpose-eval",
      data: [{ input: "hello", expected: "hello" }],
      task: async (input: string) => input,
      scores: [
        (args: { input: string; output: string; expected: string }) => ({
          name: "simple_scorer",
          score: args.output === args.expected ? 1 : 0,
        }),
      ],
    },
    new NoopProgressReporter(),
    [],
    undefined,
    undefined,
    true,
  );

  expect(result.results).toHaveLength(1);
  expect(result.results[0].scores.simple_scorer).toBe(1);

  await memoryLogger.flush();
  const logs = await memoryLogger.drain();

  // Find scorer spans (type="score")
  const scorerSpans = logs.filter(
    (l: any) => l["span_attributes"]?.["type"] === "score",
  );
  expect(scorerSpans).toHaveLength(1);

  // Verify the scorer span has purpose='scorer'
  expect((scorerSpans[0] as any).span_attributes.purpose).toBe("scorer");

  // Verify that non-scorer spans (task, eval) do NOT have purpose='scorer'
  const nonScorerSpans = logs.filter(
    (l: any) => l["span_attributes"]?.["type"] !== "score",
  );
  expect(nonScorerSpans.length).toBeGreaterThan(0);
  for (const span of nonScorerSpans) {
    expect((span as any).span_attributes?.purpose).not.toBe("scorer");
  }

  _exportsForTestingOnly.clearTestBackgroundLogger();
  _exportsForTestingOnly.simulateLogoutForTests();
});

// ========== framework2 metadata tests ==========
import { z } from "zod/v3";
import { projects, CodePrompt } from "./framework2";

describe("framework2 metadata support", () => {
  describe("CodeFunction metadata", () => {
    test("tool stores metadata correctly", () => {
      const project = projects.create({ name: "test-project" });
      const metadata = { version: "1.0", author: "test" };

      const tool = project.tools.create({
        handler: (x: number) => x * 2,
        name: "test-tool",
        parameters: z.object({ x: z.number() }),
        metadata,
      });

      expect(tool.metadata).toEqual(metadata);
      expect(tool.name).toBe("test-tool");
      expect(tool.slug).toBe("test-tool");
    });

    test("tool works without metadata", () => {
      const project = projects.create({ name: "test-project" });

      const tool = project.tools.create({
        handler: (x: number) => x * 2,
        name: "test-tool",
        parameters: z.object({ x: z.number() }),
      });

      expect(tool.metadata).toBeUndefined();
    });
  });

  describe("CodePrompt metadata", () => {
    test("prompt stores metadata correctly", () => {
      const project = projects.create({ name: "test-project" });
      const metadata = { category: "greeting", priority: "high" };

      project.prompts.create({
        name: "test-prompt",
        prompt: "Hello {{name}}",
        model: "gpt-4",
        metadata,
      });

      // The metadata is stored on the CodePrompt in _publishablePrompts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prompts = (project as any)._publishablePrompts;
      expect(prompts).toHaveLength(1);
      expect(prompts[0].metadata).toEqual(metadata);
    });

    test("prompt works without metadata", () => {
      const project = projects.create({ name: "test-project" });

      project.prompts.create({
        name: "test-prompt",
        prompt: "Hello {{name}}",
        model: "gpt-4",
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prompts = (project as any)._publishablePrompts;
      expect(prompts).toHaveLength(1);
      expect(prompts[0].metadata).toBeUndefined();
    });

    test("toFunctionDefinition includes metadata when present", async () => {
      const project = projects.create({ name: "test-project" });
      const metadata = { version: "2.0", tag: "production" };

      const codePrompt = new CodePrompt(
        project,
        {
          prompt: { type: "completion", content: "Hello {{name}}" },
          options: { model: "gpt-4" },
        },
        [],
        {
          name: "test-prompt",
          slug: "test-prompt",
          metadata,
        },
      );

      const mockProjectMap = {
        resolve: vi.fn().mockResolvedValue("project-123"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const funcDef = await codePrompt.toFunctionDefinition(mockProjectMap);

      expect(funcDef.metadata).toEqual(metadata);
      expect(funcDef.name).toBe("test-prompt");
      expect(funcDef.project_id).toBe("project-123");
    });

    test("toFunctionDefinition excludes metadata when undefined", async () => {
      const project = projects.create({ name: "test-project" });

      const codePrompt = new CodePrompt(
        project,
        {
          prompt: { type: "completion", content: "Hello {{name}}" },
          options: { model: "gpt-4" },
        },
        [],
        {
          name: "test-prompt",
          slug: "test-prompt",
        },
      );

      const mockProjectMap = {
        resolve: vi.fn().mockResolvedValue("project-123"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const funcDef = await codePrompt.toFunctionDefinition(mockProjectMap);

      expect(funcDef.metadata).toBeUndefined();
    });
  });

  describe("CodeParameters defaults", () => {
    test("toFunctionDefinition initializes data with schema defaults", async () => {
      const project = projects.create({ name: "test-project" });
      project.parameters.create({
        name: "test-parameters",
        schema: {
          title: z.string().default("default-title"),
          numSamples: z.number().default(10),
          enabled: z.boolean().default(true),
          tags: z.array(z.string()).default(["default-tag"]),
          config: z
            .object({
              retryCount: z.number(),
              strategy: z.string(),
            })
            .default({
              retryCount: 3,
              strategy: "balanced",
            }),
          datasetName: z.string(),
          main: {
            type: "prompt",
            default: {
              messages: [{ role: "user", content: "{{input}}" }],
              model: "gpt-4",
            },
          },
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parameters = (project as any)._publishableParameters;
      expect(parameters).toHaveLength(1);

      const mockProjectMap = {
        resolve: vi.fn().mockResolvedValue("project-123"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const funcDef = await parameters[0].toFunctionDefinition(mockProjectMap);

      expect(funcDef.function_data.type).toBe("parameters");
      expect(funcDef.function_data.data).toMatchObject({
        title: "default-title",
        numSamples: 10,
        enabled: true,
        tags: ["default-tag"],
        config: {
          retryCount: 3,
          strategy: "balanced",
        },
        main: {
          prompt: {
            type: "chat",
            messages: [{ role: "user", content: "{{input}}" }],
          },
          options: {
            model: "gpt-4",
          },
        },
      });
      expect(funcDef.function_data.data).not.toHaveProperty("datasetName");
    });

    test("toFunctionDefinition does not initialize data when schema has no defaults", async () => {
      const project = projects.create({ name: "test-project" });
      project.parameters.create({
        name: "test-parameters-no-defaults",
        schema: {
          title: z.string(),
          numSamples: z.number(),
          enabled: z.boolean(),
          tags: z.array(z.string()),
          config: z.object({
            retryCount: z.number(),
            strategy: z.string(),
          }),
          main: {
            type: "prompt",
          },
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parameters = (project as any)._publishableParameters;
      expect(parameters).toHaveLength(1);

      const mockProjectMap = {
        resolve: vi.fn().mockResolvedValue("project-123"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const funcDef = await parameters[0].toFunctionDefinition(mockProjectMap);

      expect(funcDef.function_data.type).toBe("parameters");
      expect(funcDef.function_data.data).toEqual({});
      expect(funcDef.function_data.data).not.toHaveProperty("title");
      expect(funcDef.function_data.data).not.toHaveProperty("numSamples");
      expect(funcDef.function_data.data).not.toHaveProperty("enabled");
      expect(funcDef.function_data.data).not.toHaveProperty("tags");
      expect(funcDef.function_data.data).not.toHaveProperty("config");
      expect(funcDef.function_data.data).not.toHaveProperty("main");
    });
  });

  describe("Scorer metadata", () => {
    test("code scorer stores metadata correctly", () => {
      const project = projects.create({ name: "test-project" });
      const metadata = { type: "accuracy", version: "1.0" };

      project.scorers.create({
        handler: ({
          output,
          expected,
        }: {
          output: string;
          expected?: string;
        }) => (output === expected ? 1 : 0),
        name: "test-scorer",
        parameters: z.object({
          output: z.string(),
          expected: z.string().optional(),
        }),
        metadata,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scorers = (project as any)._publishableCodeFunctions;
      expect(scorers).toHaveLength(1);
      expect(scorers[0].metadata).toEqual(metadata);
    });

    test("LLM scorer prompt stores metadata correctly", () => {
      const project = projects.create({ name: "test-project" });
      const metadata = { type: "llm_classifier", version: "2.0" };

      project.scorers.create({
        name: "llm-scorer",
        prompt: "Is this correct?",
        model: "gpt-4",
        useCot: true,
        choiceScores: { yes: 1.0, no: 0.0 },
        metadata,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prompts = (project as any)._publishablePrompts;
      expect(prompts).toHaveLength(1);
      expect(prompts[0].metadata).toEqual(metadata);
    });
  });

  describe("Project with messages", () => {
    test("prompt with messages stores metadata correctly", () => {
      const project = projects.create({ name: "test-project" });
      const metadata = { template: "chat", version: "1.0" };

      project.prompts.create({
        name: "chat-prompt",
        messages: [
          { role: "system", content: "You are a helpful assistant" },
          { role: "user", content: "Hello {{name}}" },
        ],
        model: "gpt-4",
        metadata,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prompts = (project as any)._publishablePrompts;
      expect(prompts).toHaveLength(1);
      expect(prompts[0].metadata).toEqual(metadata);
    });

    test("prompt with templateFormat stores it at top level", () => {
      const project = projects.create({ name: "test-project" });

      const prompt = project.prompts.create({
        name: "nunjucks-prompt",
        messages: [
          { role: "user", content: "Hello {% if name %}{{name}}{% endif %}" },
        ],
        model: "gpt-4",
        templateFormat: "nunjucks",
      });

      // Check that template_format is stored at the top level of prompt data
      expect(prompt.templateFormat).toBe("nunjucks");

      // Verify it requires the addon to render
      expect(() => prompt.build({ name: "World" })).toThrow(
        "Nunjucks templating requires @braintrust/template-nunjucks. Install and import it to enable templateFormat: 'nunjucks'.",
      );
    });
  });
});

test("Eval with enableCache: false does not use span cache", async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const state = new BraintrustState({
    apiKey: "test-api-key",
    appUrl: "https://example.com",
  });

  const startSpy = vi.spyOn(state.spanCache, "start");
  const stopSpy = vi.spyOn(state.spanCache, "stop");

  await Eval(
    "test-enable-cache-false",
    {
      data: [{ input: 1, expected: 2 }],
      task: (input) => input * 2,
      scores: [],
      state,
    },
    { noSendLogs: true, enableCache: false },
  );

  expect(startSpy).not.toHaveBeenCalled();
  expect(stopSpy).not.toHaveBeenCalled();
});

test("Eval with enableCache: true (default) uses span cache", async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
  const state = new BraintrustState({
    apiKey: "test-api-key",
    appUrl: "https://example.com",
  });

  const startSpy = vi.spyOn(state.spanCache, "start");
  const stopSpy = vi.spyOn(state.spanCache, "stop");

  await Eval(
    "test-enable-cache-true",
    {
      data: [{ input: 1, expected: 2 }],
      task: (input) => input * 2,
      scores: [],
      state,
    },
    { noSendLogs: true }, // enableCache defaults to true
  );

  expect(startSpy).toHaveBeenCalled();
  expect(stopSpy).toHaveBeenCalled();
});
