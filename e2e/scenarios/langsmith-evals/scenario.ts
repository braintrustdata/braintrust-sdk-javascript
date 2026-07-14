import { evaluate as langSmithEvaluate } from "langsmith/evaluation";
import { wrapLangSmithEvaluate } from "braintrust";
import { getTestRunId, runMain } from "../../helpers/scenario-runtime";

runMain(async () => {
  const testRunId = getTestRunId();
  const evaluate = wrapLangSmithEvaluate(langSmithEvaluate, {
    projectName: "e2e-langsmith-evals",
    standalone: true,
  });

  const result = await evaluate(
    async ({ value }) => ({ doubled: Number(value) * 2 }),
    {
      data: [
        {
          id: "example-one",
          inputs: { value: 2 },
          outputs: { doubled: 4 },
          metadata: { case: "one", testRunId },
        },
        {
          id: "example-two",
          inputs: { value: 3 },
          outputs: { doubled: 6 },
          metadata: { case: "two", testRunId },
        },
      ],
      description: "LangSmith standard eval migrated to Braintrust",
      evaluators: [
        function correctnessEvaluator({ outputs, referenceOutputs }) {
          return {
            key: "correct",
            score: outputs.doubled === referenceOutputs?.doubled,
            comment: "Compared migrated output with the reference output",
          };
        },
        function detailEvaluator({ outputs }) {
          return {
            results: [
              {
                key: "quality",
                score: 0.8,
                value: "good",
              },
              {
                key: "has_output",
                score: outputs.doubled !== undefined,
                metadata: { source: "langsmith-evals-e2e" },
              },
            ],
          };
        },
      ],
      experimentPrefix: "langsmith-standard-eval",
      maxConcurrency: 2,
      metadata: { migration: "langsmith", testRunId },
    },
  );

  if (result.results.length !== 2) {
    throw new Error(
      `Expected 2 Braintrust eval results, got ${result.results.length}`,
    );
  }
  for (const row of result.results) {
    if (
      row.scores.correct !== 1 ||
      row.scores.has_output !== 1 ||
      row.scores.quality !== 0.8
    ) {
      throw new Error(
        `Unexpected migrated scores: ${JSON.stringify(row.scores)}`,
      );
    }
  }
});
