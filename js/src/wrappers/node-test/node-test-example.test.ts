import { test, describe, afterAll, beforeAll } from "vite-plus/test";
import { currentSpan } from "../../logger/core";
import { initNodeTestSuite } from "./suite";
import {
  setupNodeTestEnv,
  teardownNodeTestEnv,
  mockTestContext,
} from "./test-helpers";

// Simulate a mock "after" function (like node:test's after)
const afterFns: Array<() => void | Promise<void>> = [];
const mockAfter = (fn: () => void | Promise<void>) => {
  afterFns.push(fn);
};

let moduleBackgroundLogger: Awaited<ReturnType<typeof setupNodeTestEnv>>;
beforeAll(async () => {
  moduleBackgroundLogger = await setupNodeTestEnv();
});

describe("Node Test Suite Example", () => {
  // Initialize suite with auto-flush via after
  const suite = initNodeTestSuite({
    projectName: "node-test-example",
    displaySummary: false,
    after: mockAfter,
    onProgress: (event) => {
      if (event.type === "test_complete") {
        console.log(
          `  ${event.testName} (${event.duration.toFixed(2)}ms) - ${event.passed ? "PASSED" : "FAILED"}`,
        );
      }
    },
  });

  // Basic test with suite.eval()
  test("basic addition", async () => {
    const fn = suite.eval(
      { input: { a: 2, b: 2 }, expected: 4 },
      async ({ input }) => {
        const { a, b } = input as { a: number; b: number };
        return a + b;
      },
    );
    await fn(mockTestContext("basic addition"));
  });

  // Test with metadata and tags
  test("multiplication with metadata", async () => {
    const fn = suite.eval(
      {
        input: { a: 3, b: 4 },
        expected: 12,
        metadata: { category: "arithmetic", difficulty: "easy" },
        tags: ["math", "multiplication"],
      },
      async ({ input }) => {
        const { a, b } = input as { a: number; b: number };
        return a * b;
      },
    );
    await fn(mockTestContext("multiplication with metadata"));
  });

  // Test with scorers
  test("string transformation with scorers", async () => {
    const fn = suite.eval(
      {
        input: "hello world",
        expected: "HELLO WORLD",
        scorers: [
          ({ output, expected }) => ({
            name: "exact_match",
            score: output === expected ? 1 : 0,
          }),
          ({ output }) => ({
            name: "is_uppercase",
            score:
              typeof output === "string" && output === output.toUpperCase()
                ? 1
                : 0,
          }),
        ],
      },
      async ({ input }) => {
        return (input as string).toUpperCase();
      },
    );
    await fn(mockTestContext("string transformation"));
  });

  // Data expansion with a loop
  const translationData = [
    { input: { text: "hello" }, expected: "hola" },
    { input: { text: "goodbye" }, expected: "adiós" },
    { input: { text: "thanks" }, expected: "gracias" },
  ];

  for (const [i, record] of translationData.entries()) {
    test(`translation [${i}]`, async () => {
      const fn = suite.eval(
        {
          input: record.input,
          expected: record.expected,
          scorers: [
            ({ output, expected }) => ({
              name: "exact_match",
              score: output === expected ? 1 : 0,
            }),
          ],
        },
        async ({ input }) => {
          // Simulate translation (just return expected for demo)
          const translations: Record<string, string> = {
            hello: "hola",
            goodbye: "adiós",
            thanks: "gracias",
          };
          return translations[(input as any).text] || "unknown";
        },
      );
      await fn(mockTestContext(`translation [${i}]`));
    });
  }

  // Test using currentSpan() for custom logging
  test("custom outputs and feedback", async () => {
    const fn = suite.eval(
      { input: { query: "test query" } },
      async ({ input }) => {
        const result = `processed: ${(input as any).query}`;
        currentSpan().log({
          output: { processed_query: result, model: "test-model" },
          scores: { relevance: 0.9 },
          metadata: { evaluator: "human" },
        });
        return result;
      },
    );
    await fn(mockTestContext("custom outputs and feedback"));
  });
});

afterAll(async () => {
  // Run the registered after hooks (simulating node:test behavior)
  for (const fn of afterFns) {
    await fn();
  }

  // Flush and verify spans were captured
  await moduleBackgroundLogger.flush();
  const spans = await moduleBackgroundLogger.drain();
  console.log(`  Example tests captured ${spans.length} spans`);

  await teardownNodeTestEnv();
});
