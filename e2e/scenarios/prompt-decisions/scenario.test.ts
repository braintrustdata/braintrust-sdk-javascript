import { expect, test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { findLatestSpan } from "../../helpers/trace-selectors";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

test("builds decisions prompts from the packaged SDK", async () => {
  await withScenarioHarness(async ({ runScenarioDir, testRunEvents }) => {
    await runScenarioDir({ scenarioDir });
    const root = findLatestSpan(testRunEvents(), "prompt-decisions");
    expect(root?.output).toEqual({
      model: "decision-model",
      input: [{ role: "user", content: "Evaluate hello" }],
      questions: [
        { type: "predicate", instructions: "Is hello a greeting?" },
        {
          type: "choice",
          instructions: "Choose the category",
          choices: [{ value: "greeting" }, { value: false }],
        },
        {
          type: "score",
          instructions: "Rate clarity",
          levels: [{ label: "clear", description: "Very clear" }],
        },
      ],
    });
  });
});
