import { beforeAll, describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findAllSpans,
  findChildSpans,
  findLatestChildSpan,
  spanInstrumentationName,
} from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const scenarios = await Promise.all(
  [
    {
      dependencyName: "deepseek-harness-v0",
      label: "v0.1 prerelease pinned",
      variantKey: "deepseek-harness-v0",
    },
    {
      dependencyName: "deepseek-harness-v0-latest",
      label: "v0.1 prerelease latest",
      variantKey: "deepseek-harness-v0-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);
const TIMEOUT_MS = 120_000;

describe.sequential("DeepSeek Harness instrumentation variants", () => {
  for (const scenario of scenarios) {
    describe(`${scenario.label} (${scenario.version})`, () => {
      let events: CapturedLogEvent[] = [];

      beforeAll(async () => {
        await withScenarioHarness(
          async ({ events: harnessEvents, runScenarioDir }) => {
            await runScenarioDir({
              entry: "scenario.ts",
              env: {
                DEEPSEEK_HARNESS_PACKAGE: scenario.dependencyName,
                NODE_ENV: "development",
              },
              runContext: {
                originalScenarioDir,
                variantKey: scenario.variantKey,
              },
              scenarioDir,
              timeoutMs: TIMEOUT_MS,
            });
            events = harnessEvents();
          },
        );
      }, TIMEOUT_MS);

      test("captures each user turn as an independent trace", async () => {
        const turns = findAllSpans(events, "deepseek_harness.turn");
        const first = turns.find(
          (turn) =>
            Array.isArray(turn.input) &&
            turn.input[0]?.content ===
              "Call lookup exactly once with query `first`. Then reply exactly: First Harness answer.",
        );
        const second = turns.find(
          (turn) =>
            Array.isArray(turn.input) &&
            turn.input[0]?.content ===
              "Call lookup exactly once with query `second`. Then reply exactly: Second Harness answer.",
        );

        expect(turns).toHaveLength(2);
        expect(first?.span.type).toBe("task");
        expect(second?.span.type).toBe("task");
        expect(first?.span.parentIds).toEqual([]);
        expect(second?.span.parentIds).toEqual([]);
        expect(first?.span.rootId).not.toEqual(second?.span.rootId);
        expect(first?.metadata?.["deepseek_harness.session_id"]).toEqual(
          second?.metadata?.["deepseek_harness.session_id"],
        );
        expect(first?.metadata?.scenario).toBe(
          "deepseek-harness-instrumentation",
        );
        expect(first?.metadata?.testRunId).toMatch(/^e2e-/);
        expect(second?.metadata?.scenario).toBe(
          "deepseek-harness-instrumentation",
        );
        expect(second?.metadata?.testRunId).toBe(first?.metadata?.testRunId);
        expect(first?.output).toBe("First Harness answer.");
        expect(second?.output).toBe("Second Harness answer.");

        for (const root of [first, second]) {
          const steps = findChildSpans(
            events,
            "deepseek_harness.step",
            root?.span.id,
          );
          const lookup = findLatestChildSpan(events, "lookup", root?.span.id);
          expect(steps).toHaveLength(2);
          expect(steps.map((step) => step.span.type)).toEqual(["llm", "llm"]);
          expect(steps.map((step) => step.metadata?.provider)).toEqual([
            "openai",
            "openai",
          ]);
          expect(steps.map((step) => step.metadata?.model)).toEqual([
            "gpt-5.6-luna",
            "gpt-5.6-luna",
          ]);
          expect(steps[0]?.output).toMatchObject([
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  { function: { name: "lookup" }, type: "function" },
                ],
              },
            },
          ]);
          expect(lookup?.span.type).toBe("tool");
          expect(lookup?.span.parentIds).toEqual([root?.span.id]);
          expect(lookup?.output).toEqual(
            expect.stringContaining("Lookup result"),
          );
          expect(root?.metrics?.tokens).toEqual(expect.any(Number));
          expect(root?.metrics?.prompt_tokens).toEqual(expect.any(Number));
          expect(root?.metrics?.completion_tokens).toEqual(expect.any(Number));
        }

        for (const event of events) {
          expect(spanInstrumentationName(event)).toBe("deepseek-harness");
        }

        await matchSpanTreeSnapshot(
          events,
          resolveFileSnapshotPath(
            import.meta.url,
            `${scenario.variantKey}.span-tree.json`,
          ),
          {
            normalize: {
              additionalProviderIdKeys: [
                "deepseek_harness.call_id",
                "deepseek_harness.session_id",
              ],
            },
          },
        );
      });
    });
  }
});
