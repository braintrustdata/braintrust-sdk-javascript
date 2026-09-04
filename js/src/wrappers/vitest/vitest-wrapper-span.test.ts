import * as vitest from "vitest";
import { configureNode } from "../../node/config";
import { wrapVitest } from "./index";
import { _exportsForTestingOnly } from "../../logger";
import * as logger from "../../logger";

configureNode();

_exportsForTestingOnly.setInitialTestState();
await _exportsForTestingOnly.simulateLoginForTests();
const moduleBackgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();

vitest.vi
  .spyOn(logger, "init")
  .mockImplementation((projectName: string, options?: any) => {
    return _exportsForTestingOnly.initTestExperiment(
      options?.experiment || "test-experiment",
      projectName,
    );
  });

const { test, describe, expect, afterAll, logOutputs, logFeedback } =
  wrapVitest(vitest, {
    projectName: "vitest-wrapper-integration-test",
    displaySummary: false,
  });

describe("Vitest Wrapper Span Creation Integration", () => {
  test("creates span and logs outputs", async () => {
    const result = { text: "test result", status: "success" };

    logOutputs({ text: result.text });
    logFeedback({ name: "quality", score: 1.0 });

    expect(result.text).toBe("test result");
  });

  test(
    "captures input and expected in span",
    {
      input: { value: 5 },
      expected: 10,
      metadata: { operation: "multiply" },
      tags: ["math"],
    },
    async ({ input, expected }) => {
      const result = input.value * 2;

      logOutputs({ result });
      logFeedback({
        name: "correctness",
        score: result === expected ? 1.0 : 0.0,
      });

      expect(result).toBe(expected);
    },
  );

  test("logs multiple outputs and feedback", async () => {
    logOutputs({ step1: "started" });
    logOutputs({ step2: "processing" });
    logOutputs({ step3: "completed" });

    logFeedback({ name: "performance", score: 0.95 });
    logFeedback({ name: "accuracy", score: 1.0 });

    expect(true).toBe(true);
  });

  test("tracks pass status automatically", async () => {
    // This test should pass and get a pass score automatically
    const result = 2 + 2;
    expect(result).toBe(4);
  });

  test("handles test without config", async () => {
    // Test without input/expected should still create a span
    const data = { value: "simple test" };
    logOutputs(data);
    expect(data.value).toBeTruthy();
  });
});

describe("Concurrent Test Span Creation", () => {
  test.concurrent("concurrent test 1", async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    logOutputs({ test: "concurrent-1" });
    expect(true).toBe(true);
  });

  test.concurrent("concurrent test 2", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    logOutputs({ test: "concurrent-2" });
    expect(true).toBe(true);
  });

  test.concurrent("concurrent test 3", async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    logOutputs({ test: "concurrent-3" });
    expect(true).toBe(true);
  });
});

// Verify spans were created and cleanup
afterAll(async () => {
  // Flush and drain spans from background logger
  await moduleBackgroundLogger.flush();
  const spans = await moduleBackgroundLogger.drain();
  expect(spans.length).toBeGreaterThan(0);
  const taskSpans = spans.filter(
    (s: any) => s.span_attributes?.type === "task",
  );
  expect(taskSpans.length).toBeGreaterThan(0);
  const spansWithPassScore = spans.filter(
    (s: any) => s.scores?.pass !== undefined,
  );
  expect(spansWithPassScore.length).toBeGreaterThan(0);
  const passingTests = spans.filter((s: any) => s.scores?.pass === 1);
  expect(passingTests.length).toBeGreaterThan(0);
  const spansWithOutputs = spans.filter((s: any) => s.output);
  expect(spansWithOutputs.length).toBeGreaterThan(0);
  const spansWithInput = spans.filter((s: any) => s.input !== undefined);
  expect(spansWithInput.length).toBeGreaterThan(0);
  const spansWithExpected = spans.filter((s: any) => s.expected !== undefined);
  expect(spansWithExpected.length).toBeGreaterThan(0);
  const spansWithMetadata = spans.filter(
    (s: any) => s.metadata && Object.keys(s.metadata).length > 0,
  );
  expect(spansWithMetadata.length).toBeGreaterThan(0);
  const spansWithTags = spans.filter((s: any) => s.tags && s.tags.length > 0);
  expect(spansWithTags.length).toBeGreaterThan(0);
  const spansWithCustomScores = spans.filter((s: any) => {
    const scores = s.scores || {};
    return Object.keys(scores).some((key) => key !== "pass");
  });
  expect(spansWithCustomScores.length).toBeGreaterThan(0);

  await _exportsForTestingOnly.clearTestBackgroundLogger();
  await _exportsForTestingOnly.simulateLogoutForTests();
});
