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

test("durable eval collects webhook sub-batches and logs completed rows", async () => {
  await withScenarioHarness(async ({ runScenarioDir, testRunEvents }) => {
    await runScenarioDir({ scenarioDir });

    const evalSpans = findAllSpans(testRunEvents(), "eval");
    const webhookSpans = evalSpans.filter(
      (event) => event.metadata?.kind === "webhook",
    );
    expect(webhookSpans).toHaveLength(3);
    expect(webhookSpans.map((event) => event.output).sort()).toEqual([2, 4, 6]);
    expect(
      webhookSpans
        .map((event) => event.scores)
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
    ).toEqual([{ exact: 1 }, { exact: 1 }, { exact: 1 }]);
    expect(webhookSpans.map((event) => event.metadata?.durable_eval)).toEqual([
      expect.objectContaining({ run_id: expect.any(String) }),
      expect.objectContaining({ run_id: expect.any(String) }),
      expect.objectContaining({ run_id: expect.any(String) }),
    ]);
  });
});
