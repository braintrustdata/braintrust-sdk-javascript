import { wrapTest, wrapDescribe, getExperimentContext } from "./wrapper";
import { wrapExpect } from "./expect-wrapper";
import { summarizeAndFlush } from "../shared/flush";
import { logOutputs, logFeedback, getCurrentSpan } from "../shared/logging";
import type { VitestMethods, BraintrustVitest, WrapperConfig } from "./types";

export type { Score } from "../../../util/score";
export type { TestConfig, TestContext, ScorerFunction } from "./types";
export type { DatasetOptions, DatasetRecord } from "./dataset-helpers";

/**
 * Wraps Vitest methods with Braintrust experiment tracking. This automatically creates
 * datasets and experiments from your Vitest tests, tracking pass/fail rates and evaluation metrics.
 * Experiments are automatically flushed after all tests complete.
 *
 * @param vitestMethods - Object containing Vitest methods (test, describe, expect, etc.)
 * @param config - Optional configuration object
 * @param config.projectName - Project name for the experiment (defaults to suite name)
 * @param config.displaySummary - If true, displays experiment summary after flushing (defaults to true)
 * @returns Wrapped Vitest methods with Braintrust experiment tracking
 *
 * @example Basic Usage
 * ```typescript
 * import * as vitest from "vitest";
 * import { wrapVitest } from 'braintrust';
 *
 * const {test, expect, describe } = wrapVitest(
 *   { projectName: 'my-project' }
 * );
 *
 * describe('Translation Tests', () => {
 *
 *   // Tests with input/expected are automatically added to the dataset
 *   test(
 *     'translates hello',
 *     {
 *       input: { text: 'hello' },
 *       expected: 'hola',
 *       metadata: { language: 'spanish' },
 *     },
 *     async ({ input, expected }) => {
 *       const result = await translate(input.text);
 *       bt.logOutputs({ translation: result });
 *       expect(result).toBe(expected);
 *     }
 *   );
 *
 *   // Tests without input/expected still run and track pass/fail
 *   test('basic functionality', async () => {
 *     const result = await someFunction();
 *     expect(result).toBeTruthy();
 *   });
 * });
 * ```
 *
 * @see README.md for full documentation and examples
 */
export function wrapVitest<
  VitestContext = unknown,
  ExpectType extends (...args: unknown[]) => unknown = (
    ...args: unknown[]
  ) => unknown,
>(
  vitestMethods: VitestMethods<VitestContext, ExpectType>,
  config: WrapperConfig = {},
): BraintrustVitest<VitestContext, ExpectType> {
  if (!vitestMethods.test) {
    throw new Error(
      "Braintrust: vitestMethods.test is required. Please pass in the test function from vitest.",
    );
  }
  if (!vitestMethods.describe) {
    throw new Error(
      "Braintrust: vitestMethods.describe is required. Please pass in the describe function from vitest.",
    );
  }
  if (!vitestMethods.expect) {
    throw new Error(
      "Braintrust: vitestMethods.expect is required. Please pass in the expect function from vitest.",
    );
  }

  const wrappedTest = wrapTest<VitestContext>(vitestMethods.test, config);
  const wrappedDescribe = wrapDescribe(
    vitestMethods.describe,
    config,
    vitestMethods.afterAll,
  );

  return {
    test: wrappedTest,
    it: wrappedTest,
    expect: wrapExpect(vitestMethods.expect),
    describe: wrappedDescribe,
    beforeAll: vitestMethods.beforeAll || (() => {}),
    afterAll: vitestMethods.afterAll || (() => {}),
    beforeEach: vitestMethods.beforeEach,
    afterEach: vitestMethods.afterEach,
    logOutputs,
    logFeedback,
    getCurrentSpan,
    flushExperiment: async (options?: { displaySummary?: boolean }) => {
      const ctx = getExperimentContext();
      if (!ctx) {
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        console.warn(
          "Braintrust: No experiment context found. Make sure you're using bt.describe() and calling flushExperiment() within an afterAll() hook.",
        );
        return;
      }

      await summarizeAndFlush(ctx.experiment, {
        displaySummary: options?.displaySummary ?? config.displaySummary,
      });
    },
  };
}
