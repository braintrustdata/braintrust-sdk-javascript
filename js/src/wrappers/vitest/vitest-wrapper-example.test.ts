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
    projectName: "vitest-wrapper-demo",
    displaySummary: false, // Disable auto-flush for tests
    onProgress: (event) => {
      if (event.type === "test_complete") {
        console.log(
          `✓ ${event.testName} (${event.duration.toFixed(2)}ms) - ${event.passed ? "PASSED" : "FAILED"}`,
        );
      }
    },
  });

describe("Math Operations", () => {
  test("addition works correctly", async () => {
    const result = 2 + 2;
    // Log custom outputs
    logOutputs({ result, operation: "addition" });

    // Log custom feedback/scores
    logFeedback({ name: "correctness", score: 1.0 });

    expect(result).toBe(4);
  });

  test("multiplication works correctly", async () => {
    const result = 3 * 4;

    logOutputs({ result, operation: "multiplication" });
    logFeedback({ name: "correctness", score: 1.0 });

    expect(result).toBe(12);
  });

  test("division works correctly", async () => {
    const result = 10 / 2;

    logOutputs({ result, operation: "division" });
    logFeedback({ name: "correctness", score: 1.0 });

    expect(result).toBe(5);
  });

  // Test with input/expected/metadata
  test(
    "handles complex calculation",
    {
      input: { a: 5, b: 3, operation: "power" },
      expected: 125,
      metadata: { category: "advanced", difficulty: "medium" },
    },
    async ({ input, expected }) => {
      const result = Math.pow(input.a, input.b);

      logOutputs({ result });
      logFeedback({
        name: "accuracy",
        score: result === expected ? 1.0 : 0.0,
      });

      expect(result).toBe(expected);
    },
  );
});

// Example of concurrent tests
describe("Concurrent Operations", () => {
  test.concurrent("async operation 1", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    logOutputs({ operation: "async-1", duration: 100 });
    expect(true).toBe(true);
  });

  test.concurrent("async operation 2", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    logOutputs({ operation: "async-2", duration: 50 });
    expect(true).toBe(true);
  });

  test.concurrent("async operation 3", async () => {
    await new Promise((resolve) => setTimeout(resolve, 75));
    logOutputs({ operation: "async-3", duration: 75 });
    expect(true).toBe(true);
  });
});

// ✅ STEP 4: Module-level cleanup after all tests complete
afterAll(async () => {
  // Flush and verify spans were captured
  await moduleBackgroundLogger.flush();
  const spans = await moduleBackgroundLogger.drain();
  console.log(`✅ Example tests captured ${spans.length} spans`);

  // Cleanup
  await _exportsForTestingOnly.clearTestBackgroundLogger();
  await _exportsForTestingOnly.simulateLogoutForTests();
});
