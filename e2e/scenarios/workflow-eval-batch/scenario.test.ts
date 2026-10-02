import { expect, test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { findAllSpans } from "../../helpers/trace-selectors";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

test("workflow eval submits tasks and scorers in provider batches", async () => {
  await withScenarioHarness(
    async ({ events, runScenarioDir, testRunEvents }) => {
      await runScenarioDir({ scenarioDir });

      const evalSpans = findAllSpans(testRunEvents(), "eval")
        .filter((event) => event.metadata?.kind === "batch")
        .sort((left, right) => Number(left.input) - Number(right.input));
      expect(evalSpans.map((event) => event.input)).toEqual([1, 2, 3, 4]);
      expect(evalSpans.map((event) => event.output ?? null)).toEqual([
        2,
        4,
        6,
        null,
      ]);
      expect(evalSpans.map((event) => event.scores ?? null)).toEqual([
        { exact: 1, batch_exact: 1 },
        { exact: 1, batch_exact: 1 },
        { exact: 1 },
        null,
      ]);
      expect(
        evalSpans.map((event) => event.metadata?.scorer_errors ?? null),
      ).toEqual([null, null, { batch_exact: "judge unavailable" }, null]);
      expect(evalSpans.map((event) => event.row.error ?? null)).toEqual([
        null,
        null,
        null,
        expect.stringContaining("provider rejected request"),
      ]);
      const batchIds = evalSpans.map(
        (event) =>
          (event.metadata?.workflow_eval as Record<string, unknown>)
            .batch_submission_id,
      );
      expect(batchIds[0]).toEqual(expect.any(String));
      expect(new Set(batchIds).size).toBe(2);

      const taskSpans = findAllSpans(events(), "task");
      expect(taskSpans).toHaveLength(4);
      expect(
        taskSpans.filter((event) =>
          String(event.row.error).includes("provider rejected request"),
        ),
      ).toHaveLength(1);

      const batchScoreSpans = findAllSpans(events(), "batch_exact");
      expect(batchScoreSpans).toHaveLength(3);
      expect(
        batchScoreSpans
          .map((event) => event.scores ?? event.row.error)
          .sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
      ).toEqual([
        expect.stringContaining("judge unavailable"),
        { batch_exact: 1 },
        { batch_exact: 1 },
      ]);
      expect(findAllSpans(events(), "exact")).toHaveLength(3);
    },
  );
});
