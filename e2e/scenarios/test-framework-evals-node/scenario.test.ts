import { expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findLatestSpan } from "../../helpers/trace-selectors";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;
const spanTreeSnapshotPath = resolveFileSnapshotPath(
  import.meta.url,
  "span-tree.json",
);

test(
  "test-framework-evals-node captures node:test task spans",
  {
    timeout: TIMEOUT_MS,
  },
  async () => {
    await withScenarioHarness(
      async ({ runScenarioDir, testRunEvents, testRunId }) => {
        await runScenarioDir({ scenarioDir, timeoutMs: TIMEOUT_MS });

        const capturedEvents = testRunEvents();
        const basicEval = findLatestSpan(
          capturedEvents,
          "node-test basic eval",
        );
        const configuredEval = findLatestSpan(
          capturedEvents,
          "node-test configured eval",
        );
        const extraOutput = findLatestSpan(
          capturedEvents,
          "node-test extra output",
        );
        const nameOverride = findLatestSpan(
          capturedEvents,
          "node-test overridden name",
        );

        for (const span of [
          basicEval,
          configuredEval,
          extraOutput,
          nameOverride,
        ]) {
          expect(span).toBeDefined();
          expect(span?.span.type).toBe("task");
        }

        expect(configuredEval?.input).toEqual({ value: 5 });
        expect(configuredEval?.expected).toBe(10);
        expect(configuredEval?.row.metadata).toMatchObject({
          case: "configured-eval",
          scenario: "test-framework-evals-node",
          testRunId,
        });
        expect(configuredEval?.row.tags).toEqual(["math", "configured"]);
        expect(configuredEval?.scores).toMatchObject({
          correctness: 1,
          pass: 1,
        });
        expect(configuredEval?.output).toBe(10);

        expect(extraOutput?.output).toMatchObject({
          done: true,
          phase: "extra-output",
        });
        expect(extraOutput?.scores).toMatchObject({
          quality: 0.95,
          pass: 1,
        });

        expect(nameOverride?.span.name).toBe("node-test overridden name");

        await matchSpanTreeSnapshot(capturedEvents, spanTreeSnapshotPath);
      },
    );
  },
);
