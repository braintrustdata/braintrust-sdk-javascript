/**
 * Eval smoke test suite
 * Tests that Eval can run end-to-end in the current runtime without making real API calls.
 */

import {
  assertDefined,
  assertEqual,
  assertHasProperty,
  assertType,
} from "../helpers/assertions";
import { register, type TestFn } from "../helpers/register";

function exactMatchScore({
  output,
  expected,
}: {
  output: string;
  expected: string;
}) {
  return { name: "exact_match", score: output === expected ? 1 : 0 };
}

export const testEvalSmoke: TestFn = register(
  "testEvalSmoke",
  async (braintrust) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Eval = braintrust.Eval as any;

    assertDefined(Eval, "Eval must exist");
    assertType(Eval, "function", "Eval must be a function");

    const evalData = [
      { input: "Alice", expected: "Hi Alice" },
      { input: "Bob", expected: "Hi Bob" },
      { input: "Charlie", expected: "Hi Charlie" },
    ];

    const result = await Eval(
      "smoke-eval-test",
      {
        data: evalData,
        task: async (input: string) => `Hi ${input}`,
        scores: [exactMatchScore],
      },
      {
        noSendLogs: true,
        returnResults: true,
      },
    );

    assertDefined(result, "Eval should return a result");
    const r = result as Record<string, unknown>;

    assertHasProperty(r, "summary", "Eval result missing summary");
    assertHasProperty(r, "results", "Eval result missing results");

    const summary = r.summary as Record<string, unknown>;
    const results = r.results as Array<Record<string, unknown>>;

    assertEqual(
      results.length,
      evalData.length,
      `Expected ${evalData.length} eval results`,
    );

    for (const row of results) {
      assertDefined(row.input, "Eval result missing input");
      assertDefined(row.expected, "Eval result missing expected");
      assertDefined(row.output, "Eval result missing output");
      assertEqual(
        row.output as string,
        row.expected as string,
        "Output should equal expected",
      );

      assertHasProperty(row, "scores", "Eval result missing scores");
      const scores = row.scores as Record<string, unknown>;
      assertDefined(scores.exact_match, "Missing exact_match score");
      assertEqual(scores.exact_match as number, 1, "exact_match should be 1");
    }

    assertHasProperty(summary, "scores", "Summary missing scores");
    const summaryScores = summary.scores as Record<string, unknown>;
    assertHasProperty(
      summaryScores,
      "exact_match",
      "Summary missing exact_match scorer",
    );
    const exact = summaryScores.exact_match as Record<string, unknown>;
    assertDefined(exact.score, "Summary exact_match missing score");
    assertEqual(
      exact.score as number,
      1,
      "Summary exact_match.score should be 1",
    );

    return `Eval smoke test passed (${evalData.length} cases)`;
  },
);
