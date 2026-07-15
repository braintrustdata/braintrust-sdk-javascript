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

interface VitestScenario {
  dependencyName: string;
  entry: string;
  label: string;
  variantKey: string;
}

const scenarios: VitestScenario[] = [
  {
    dependencyName: "vitest-v2",
    entry: "scenario.ts",
    label: "vitest-v2",
    variantKey: "vitest-v2",
  },
  {
    dependencyName: "vitest-v2-latest",
    entry: "scenario.ts",
    label: "vitest-v2-latest",
    variantKey: "vitest-v2-latest",
  },
  {
    dependencyName: "vitest-v3",
    entry: "scenario.vitest-v3.ts",
    label: "vitest-v3",
    variantKey: "vitest-v3",
  },
  {
    dependencyName: "vitest-v3-latest",
    entry: "scenario.vitest-v3.ts",
    label: "vitest-v3-latest",
    variantKey: "vitest-v3-latest",
  },
  {
    dependencyName: "vitest-v4",
    entry: "scenario.vitest-v4.ts",
    label: "vitest-v4",
    variantKey: "vitest-v4",
  },
  {
    dependencyName: "vitest-v4-latest",
    entry: "scenario.vitest-v4.ts",
    label: "vitest-v4-latest",
    variantKey: "vitest-v4-latest",
  },
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
            env: { VITEST_PACKAGE_NAME: scenario.dependencyName },
            runContext: {
              cassette: false,
              variantKey: scenario.variantKey,
            },
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

          await matchSpanTreeSnapshot(
            capturedEvents,
            resolveFileSnapshotPath(
              import.meta.url,
              `${scenario.label}.span-tree.json`,
            ),
          );
        },
      );
    },
  );
}

test(
  "test-framework-evals-vitest captures vitest-evals reporter spans",
  {
    timeout: TIMEOUT_MS,
  },
  async () => {
    await withScenarioHarness(async ({ events, runScenarioDir, testRunId }) => {
      await runScenarioDir({
        entry: "scenario.vitest-evals-reporter.ts",
        runContext: {
          cassette: false,
          variantKey: "vitest-evals-reporter",
        },
        scenarioDir,
        timeoutMs: TIMEOUT_MS,
      });

      const capturedEvents = events();
      const evalRoot = findLatestSpan(
        capturedEvents,
        "vitest-evals braintrust reporter > approves refundable invoice",
      );
      const modelSpan = findLatestSpan(capturedEvents, "classify refund");
      const toolSpan = findLatestSpan(capturedEvents, "lookupInvoice");

      expect(evalRoot).toBeDefined();
      expect(evalRoot?.span.type).toBe("eval");
      expect(evalRoot?.input).toMatchObject({
        input: "Refund invoice inv_123",
        test: "vitest-evals braintrust reporter > approves refundable invoice",
      });
      expect(evalRoot?.output).toMatchObject({
        status: "approved",
      });
      expect(evalRoot?.scores).toMatchObject({
        StatusJudge: 1,
        avg_score: 1,
        pass: 1,
      });
      expect(evalRoot?.metrics).toMatchObject({
        input_tokens: 11,
        output_tokens: 13,
        total_tokens: 24,
        tool_calls: 1,
      });
      expect(evalRoot?.row.metadata).toMatchObject({
        artifacts: {
          case: "vitest-evals-reporter",
          scenario: "test-framework-evals-vitest",
          testRunId,
        },
        harnessName: "braintrust-refund-harness",
        status: "passed",
      });

      expect(modelSpan?.span.type).toBe("llm");
      expect(toolSpan?.span.type).toBe("tool");
      expect(toolSpan?.span.parentIds).toEqual([modelSpan?.span.id ?? ""]);

      await matchSpanTreeSnapshot(
        capturedEvents,
        resolveFileSnapshotPath(
          import.meta.url,
          "vitest-evals-reporter.span-tree.json",
        ),
      );
    });
  },
);
