import { expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findAllSpans, findChildSpans } from "../../helpers/trace-selectors";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

test("wrapLangSmithEvaluate migrates a standard LangSmith eval", async () => {
  await withScenarioHarness(async ({ events, runScenarioDir, testRunId }) => {
    await runScenarioDir({ scenarioDir, timeoutMs: 30_000 });

    const capturedEvents = events();
    const evalRoots = findAllSpans(capturedEvents, "eval").filter(
      (event) => event.metadata?.testRunId === testRunId,
    );
    expect(evalRoots).toHaveLength(2);

    for (const root of evalRoots) {
      expect(root.span.type).toBe("eval");
      expect(root.output).toMatchObject({ doubled: expect.any(Number) });
      expect(root.expected).toMatchObject({
        inputs: { value: expect.any(Number) },
        outputs: { doubled: expect.any(Number) },
      });
      expect(root.metadata).toMatchObject({
        case: expect.stringMatching(/one|two/),
        testRunId,
      });
      expect(findChildSpans(capturedEvents, "task", root.span.id)).toHaveLength(
        1,
      );
      const correctness = findChildSpans(
        capturedEvents,
        "correctnessEvaluator",
        root.span.id,
      );
      const details = findChildSpans(
        capturedEvents,
        "detailEvaluator",
        root.span.id,
      );
      expect(correctness).toHaveLength(1);
      expect(correctness[0].scores).toEqual({ correct: 1 });
      expect(details).toHaveLength(1);
      expect(details[0].scores).toEqual({
        has_output: 1,
        quality: 0.8,
      });
    }

    const rootIds = new Set(evalRoots.map((root) => root.span.rootId));
    await matchSpanTreeSnapshot(
      capturedEvents.filter((event) => rootIds.has(event.span.rootId)),
      resolveFileSnapshotPath(import.meta.url, "span-tree.json"),
    );
  });
});
