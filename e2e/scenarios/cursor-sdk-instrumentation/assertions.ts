import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunCursorSDKScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function findOperation(events: CapturedLogEvent[], name: string) {
  return findLatestSpan(events, name);
}

function findCursorTask(events: CapturedLogEvent[], operationName: string) {
  const operation = findOperation(events, operationName);
  return findChildSpans(events, "Cursor Agent", operation?.span.id).at(-1);
}

export function defineCursorSDKInstrumentationAssertions(options: {
  name: string;
  runScenario: RunCursorSDKScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);
  const testConfig = { timeout: timeoutMs };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, timeoutMs);

    test(
      "captures Cursor Agent task spans for run-producing APIs",
      testConfig,
      () => {
        for (const operationName of [
          "cursor-sdk-prompt-operation",
          "cursor-sdk-stream-operation",
          "cursor-sdk-wait-operation",
          "cursor-sdk-resume-conversation-operation",
        ]) {
          const operation = findOperation(events, operationName);
          const task = findCursorTask(events, operationName);

          expect(operation).toBeDefined();
          expect(
            findChildSpans(events, "Cursor Agent", operation?.span.id),
          ).toHaveLength(1);
          expect(task).toBeDefined();
          expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
          expect(task?.row.metadata).toMatchObject({
            provider: "cursor",
          });
        }
      },
    );

    test(
      "matches the shared span tree snapshot",
      testConfig,
      async ({ expect }) => {
        const root = findLatestSpan(events, ROOT_NAME);
        expect(root).toBeDefined();
        expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
        await matchSpanTreeSnapshot(events, snapshotPath, {
          snapshotExpect: expect,
        });
      },
    );
  });
}
