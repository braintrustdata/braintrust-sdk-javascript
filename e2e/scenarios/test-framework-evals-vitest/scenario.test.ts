import { expect, test } from "vitest";
import {
  matchFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { formatSpanTreeSnapshot } from "../../helpers/span-tree";
import { findLatestSpan } from "../../helpers/trace-selectors";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const TIMEOUT_MS = 90_000;

interface VitestScenario {
  entry: string;
  label: string;
}

const scenarios: VitestScenario[] = [
  { entry: "scenario.ts", label: "v2" },
  { entry: "scenario.vitest-v3.ts", label: "v3" },
  { entry: "scenario.vitest-v4.ts", label: "v4.1" },
];

for (const scenario of scenarios) {
  test(
    `test-framework-evals-vitest captures wrapped Vitest task spans (${scenario.label})`,
    {
      timeout: TIMEOUT_MS,
    },
    async () => {
      await withScenarioHarness(
        async ({ runScenarioDir, testRunEvents, testRunId }) => {
          await runScenarioDir({
            entry: scenario.entry,
            scenarioDir,
            timeoutMs: TIMEOUT_MS,
          });

          const capturedEvents = testRunEvents();
          const simplePass = findLatestSpan(
            capturedEvents,
            "vitest simple pass",
          );
          const configured = findLatestSpan(
            capturedEvents,
            "vitest configured span",
          );
          const concurrentAlpha = findLatestSpan(
            capturedEvents,
            "vitest concurrent alpha",
          );
          const concurrentBeta = findLatestSpan(
            capturedEvents,
            "vitest concurrent beta",
          );
          const expectedFailure = findLatestSpan(
            capturedEvents,
            "vitest expected failure",
          );

          for (const span of [
            simplePass,
            configured,
            concurrentAlpha,
            concurrentBeta,
            expectedFailure,
          ]) {
            expect(span).toBeDefined();
            expect(span?.span.type).toBe("task");
          }

          expect(configured?.input).toEqual({ value: 5 });
          expect(configured?.expected).toBe(10);
          expect(configured?.row.metadata).toMatchObject({
            case: "configured-span",
            scenario: "test-framework-evals-vitest",
            testRunId,
          });
          expect(configured?.row.tags).toEqual(["math", "configured"]);
          expect(configured?.scores).toMatchObject({
            correctness: 1,
            pass: 1,
            quality: 0.9,
          });
          expect(configured?.output).toMatchObject({
            phase: "configured-span",
            result: 10,
          });

          expect(concurrentAlpha?.output).toMatchObject({
            phase: "concurrent-alpha",
          });
          expect(concurrentBeta?.output).toMatchObject({
            phase: "concurrent-beta",
          });

          expect(expectedFailure?.scores).toMatchObject({
            pass: 0,
          });

          await matchFileSnapshot(
            formatSpanTreeSnapshot(capturedEvents),
            resolveFileSnapshotPath(
              import.meta.url,
              `${scenario.label}.span-tree.txt`,
            ),
          );
        },
      );
    },
  );
}
