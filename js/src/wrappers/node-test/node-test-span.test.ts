import { test, expect, describe, afterAll, beforeAll } from "vite-plus/test";
import { currentSpan } from "../../logger/core";
import { initNodeTestSuite } from "./suite";
import {
  setupNodeTestEnv,
  teardownNodeTestEnv,
  mockTestContext,
} from "./test-helpers";

const suite = initNodeTestSuite({
  projectName: "node-test-span-integration",
  displaySummary: false,
});

let moduleBackgroundLogger: Awaited<ReturnType<typeof setupNodeTestEnv>>;
beforeAll(async () => {
  moduleBackgroundLogger = await setupNodeTestEnv();
});

describe("Node Test Suite Span Creation Integration", () => {
  test("creates span with input and expected", async () => {
    const fn = suite.eval(
      {
        input: { value: 5 },
        expected: 10,
        metadata: { operation: "multiply" },
        tags: ["math"],
      },
      async ({ input }) => {
        return (input as any).value * 2;
      },
    );

    await fn(mockTestContext("multiply test"));
  });

  test("creates span with custom outputs and feedback", async () => {
    const fn = suite.eval({ input: "test-data" }, async () => {
      currentSpan().log({
        output: { step1: "started", step2: "completed" },
        scores: { quality: 0.95 },
      });
      return "final result";
    });

    await fn(mockTestContext("output-feedback test"));
  });

  test("creates span with scorer results", async () => {
    const fn = suite.eval(
      {
        input: "hello",
        expected: "HELLO",
        scorers: [
          ({ output, expected }) => ({
            name: "case_match",
            score: output === expected ? 1 : 0,
          }),
        ],
      },
      async ({ input }) => {
        return (input as string).toUpperCase();
      },
    );

    await fn(mockTestContext("scorer test"));
  });

  test("creates span for passing test with pass score", async () => {
    const fn = suite.eval({ input: "simple" }, async () => {
      return "result";
    });

    await fn(mockTestContext("pass test"));
  });
});

afterAll(async () => {
  await suite.flush();

  await moduleBackgroundLogger.flush();
  const spans = await moduleBackgroundLogger.drain();

  // Verify spans were created
  expect(spans.length).toBeGreaterThan(0);

  // Verify task type spans exist
  const taskSpans = spans.filter(
    (s: any) => s.span_attributes?.type === "task",
  );
  expect(taskSpans.length).toBeGreaterThan(0);

  // Verify pass scores exist
  const spansWithPassScore = spans.filter(
    (s: any) => s.scores?.pass !== undefined,
  );
  expect(spansWithPassScore.length).toBeGreaterThan(0);

  // Verify passing tests
  const passingTests = spans.filter((s: any) => s.scores?.pass === 1);
  expect(passingTests.length).toBeGreaterThan(0);

  // Verify spans have output
  const spansWithOutputs = spans.filter((s: any) => s.output);
  expect(spansWithOutputs.length).toBeGreaterThan(0);

  // Verify spans have input
  const spansWithInput = spans.filter((s: any) => s.input !== undefined);
  expect(spansWithInput.length).toBeGreaterThan(0);

  // Verify spans have expected
  const spansWithExpected = spans.filter((s: any) => s.expected !== undefined);
  expect(spansWithExpected.length).toBeGreaterThan(0);

  // Verify spans have metadata
  const spansWithMetadata = spans.filter(
    (s: any) => s.metadata && Object.keys(s.metadata).length > 0,
  );
  expect(spansWithMetadata.length).toBeGreaterThan(0);

  // Verify spans have tags
  const spansWithTags = spans.filter((s: any) => s.tags && s.tags.length > 0);
  expect(spansWithTags.length).toBeGreaterThan(0);

  // Verify custom scores (from scorers)
  const spansWithCustomScores = spans.filter((s: any) => {
    const scores = s.scores || {};
    return Object.keys(scores).some((key) => key !== "pass");
  });
  expect(spansWithCustomScores.length).toBeGreaterThan(0);

  await teardownNodeTestEnv();
});
