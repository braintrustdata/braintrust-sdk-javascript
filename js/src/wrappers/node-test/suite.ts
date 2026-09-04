import { init, type Experiment } from "../../logger";
import { runTracedEval } from "../shared/traced-eval";
import { summarizeAndFlush } from "../shared/flush";
import type {
  NodeTestSuiteConfig,
  EvalConfig,
  EvalContext,
  MinimalTestContext,
  NodeTestSuite,
} from "./types";

/**
 * Creates a new Node.js test suite with Braintrust experiment tracking.
 *
 * @example
 * ```typescript
 * import { test, describe, after } from 'node:test';
 * import { initNodeTestSuite } from 'braintrust';
 *
 * describe('My Tests', () => {
 *   const suite = initNodeTestSuite({ projectName: 'my-project', after });
 *
 *   test('my eval', suite.eval(
 *     { input: 'hello', expected: 'world', scorers: [myScorer] },
 *     async ({ input }) => {
 *       return await myFunction(input);
 *     }
 *   ));
 * });
 * ```
 */
export function initNodeTestSuite(config: NodeTestSuiteConfig): NodeTestSuite {
  let experiment: Experiment | undefined;

  const getOrCreateExperiment = (): Experiment => {
    if (experiment) {
      return experiment;
    }

    const experimentName =
      config.experimentName ||
      `${config.projectName}-${new Date().toISOString()}`;
    experiment = init({
      project: config.projectName,
      experiment: experimentName,
    });
    return experiment;
  };

  function evalFunc(
    evalConfig: EvalConfig,
    fn: (context: EvalContext) => unknown | Promise<unknown>,
  ): (t: MinimalTestContext) => Promise<void> {
    return async (t: MinimalTestContext) => {
      const exp = getOrCreateExperiment();
      const spanName = evalConfig.name ?? t.name ?? "unnamed test";

      if (config.onProgress) {
        config.onProgress({ type: "test_start", testName: spanName });
      }

      const startTime = performance.now();
      let passed = false;

      try {
        await runTracedEval({
          experiment: exp,
          spanName,
          input: evalConfig.input,
          expected: evalConfig.expected,
          metadata: evalConfig.metadata,
          tags: evalConfig.tags,
          scorers: evalConfig.scorers,
          fn: () =>
            fn({
              input: evalConfig.input,
              expected: evalConfig.expected,
              metadata: evalConfig.metadata,
            }),
        });
        passed = true;
      } catch (error) {
        passed = false;
        throw error;
      } finally {
        if (config.onProgress) {
          config.onProgress({
            type: "test_complete",
            testName: spanName,
            passed,
            duration: performance.now() - startTime,
          });
        }
      }
    };
  }

  async function flush(): Promise<void> {
    if (!experiment) {
      return;
    }

    await summarizeAndFlush(experiment, {
      displaySummary: config.displaySummary,
    });
    experiment = undefined;
  }

  const suite: NodeTestSuite = {
    eval: evalFunc,
    flush,
  };

  // Auto-register flush hook if after() was provided
  if (config.after) {
    config.after(() => suite.flush());
  }

  return suite;
}
