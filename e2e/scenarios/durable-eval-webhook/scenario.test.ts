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

test("durable eval collects task and scorer webhook sub-batches", async () => {
  await withScenarioHarness(
    async ({ events, runScenarioDir, testRunEvents }) => {
      await runScenarioDir({ scenarioDir });

      const evalSpans = findAllSpans(testRunEvents(), "eval");
      const webhookSpans = evalSpans.filter(
        (event) => event.metadata?.kind === "webhook",
      );
      expect(webhookSpans).toHaveLength(3);
      expect(webhookSpans.map((event) => event.output).sort()).toEqual([
        2, 4, 6,
      ]);
      expect(
        webhookSpans
          .map((event) => event.scores)
          .sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
      ).toEqual([
        { batch_exact: 1, exact: 1 },
        { batch_exact: 1, exact: 1 },
        { batch_exact: 1, exact: 1 },
      ]);
      expect(webhookSpans.map((event) => event.metadata?.durable_eval)).toEqual(
        [
          expect.objectContaining({ run_id: expect.any(String) }),
          expect.objectContaining({ run_id: expect.any(String) }),
          expect.objectContaining({ run_id: expect.any(String) }),
        ],
      );

      const taskSpans = findAllSpans(events(), "task");
      expect(taskSpans).toHaveLength(3);
      expect(taskSpans.map((event) => event.output).sort()).toEqual([2, 4, 6]);

      const exactScoreSpans = findAllSpans(events(), "exact");
      expect(exactScoreSpans).toHaveLength(3);
      expect(exactScoreSpans.map((event) => event.scores)).toEqual([
        { exact: 1 },
        { exact: 1 },
        { exact: 1 },
      ]);
      expect(exactScoreSpans.map((event) => event.metadata?.method)).toEqual([
        "shared-eval-runtime",
        "shared-eval-runtime",
        "shared-eval-runtime",
      ]);

      const batchScoreSpans = findAllSpans(events(), "batch_exact");
      expect(batchScoreSpans).toHaveLength(3);
      expect(batchScoreSpans.map((event) => event.scores)).toEqual([
        { batch_exact: 1 },
        { batch_exact: 1 },
        { batch_exact: 1 },
      ]);
      expect(batchScoreSpans.map((event) => event.metadata?.method)).toEqual([
        "batch-provider",
        "batch-provider",
        "batch-provider",
      ]);

      const classifierSpans = findAllSpans(events(), "quality");
      expect(classifierSpans).toHaveLength(3);
      expect(webhookSpans.map((event) => event.row.classifications)).toEqual([
        { quality: [{ id: "pass", label: "Pass" }] },
        { quality: [{ id: "pass", label: "Pass" }] },
        { quality: [{ id: "pass", label: "Pass" }] },
      ]);
    },
  );
});
