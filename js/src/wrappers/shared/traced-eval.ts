import { logError, type Span } from "../../logger/core";
import { type Experiment } from "../../logger/experiments";
import { SpanTypeAttribute } from "../../../util/index";
import { runScorers } from "./scorers";
import type { ScorerFunction } from "./types";

/**
 * Runs a test function inside an experiment span, handling:
 * - Scorer invocation (once, regardless of pass/fail)
 * - pass: 1/0 scoring
 * - Output logging
 * - Error logging via the top-level `error` field
 */
export async function runTracedEval(args: {
  experiment: Experiment;
  spanName: string;
  input?: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  scorers?: ScorerFunction[];
  fn: () => unknown | Promise<unknown>;
}): Promise<unknown> {
  return args.experiment.traced(
    async (span: Span) => {
      let testResult: unknown;
      let testError: unknown;

      try {
        testResult = await args.fn();
      } catch (error) {
        testError = error;
      }

      // Run scorers once regardless of outcome
      if (args.scorers && args.scorers.length > 0) {
        await runScorers({
          scorers: args.scorers,
          output: testResult,
          expected: args.expected,
          input: args.input,
          metadata: args.metadata,
          span,
        });
      }

      if (testError) {
        span.log({ scores: { pass: 0 } });
        logError(span, testError);
        throw testError;
      }

      span.log({
        scores: { pass: 1 },
        ...(testResult !== undefined ? { output: testResult } : {}),
      });

      return testResult;
    },
    {
      name: args.spanName,
      spanAttributes: {
        type: SpanTypeAttribute.TASK,
      },
      event: {
        input: args.input,
        expected: args.expected,
        metadata: args.metadata,
        tags: args.tags,
      },
    },
  );
}
