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

test("trace sampling drops whole roots before ingestion and permits a root override", async () => {
  await withScenarioHarness(async ({ runScenarioDir, testRunEvents }) => {
    await runScenarioDir({ scenarioDir });

    const events = testRunEvents();
    const keptRoot = findLatestSpan(events, "trace-sampling-kept-root");
    const keptChild = findLatestSpan(events, "trace-sampling-kept-child");

    expect(keptRoot).toBeDefined();
    expect(keptChild?.span.parentIds).toEqual([keptRoot?.span.id ?? ""]);
    expect(
      events.some(
        (event) =>
          event.span.name === "trace-sampling-dropped-root" ||
          event.span.name === "trace-sampling-dropped-child",
      ),
    ).toBe(false);
  });
});
