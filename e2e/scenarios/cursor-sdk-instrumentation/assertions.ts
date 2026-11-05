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
    env?: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
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
  promptUsage: boolean;
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
            "cursor_sdk.status": "finished",
          });
          expect(task?.row.error).toBeUndefined();
          expect(task?.row.output).toEqual(expect.any(String));
          const metrics = task?.row.metrics as
            | Record<string, number>
            | undefined;
          if (
            operationName !== "cursor-sdk-prompt-operation" ||
            options.promptUsage
          ) {
            expect(metrics?.prompt_tokens).toBeGreaterThan(0);
            expect(metrics?.completion_tokens).toBeGreaterThan(0);
            expect(metrics?.tokens).toBe(
              Number(metrics?.prompt_tokens) +
                Number(metrics?.completion_tokens),
            );
          } else {
            // 1.0.12 has neither prompt callbacks nor usage on RunResult.
            expect(metrics?.tokens).toBeUndefined();
          }
        }
      },
    );

    test("captures model output, tools, subagents, and user callbacks", () => {
      for (const [operation, output] of [
        ["prompt", "CURSOR_PROMPT_OK"],
        ["wait", "CURSOR_WAIT_OK"],
        ["resume-conversation", "CURSOR_CONVERSATION_OK"],
      ]) {
        expect(
          findCursorTask(events, `cursor-sdk-${operation}-operation`)?.row
            .output,
        ).toContain(output);
      }
      const task = findCursorTask(events, "cursor-sdk-stream-operation");
      expect(task?.row.output).toContain("CURSOR_SUBAGENT_OK");
      expect(task?.row.output).toContain("cursor_tool_ok");
      const shell = findChildSpans(events, "shell", task?.span.id);
      expect(shell).toHaveLength(1);
      expect(shell[0].row.output).toMatchObject({
        status: "success",
        value: { exitCode: 0, stdout: "cursor_tool_ok" },
      });
      const tool = findChildSpans(events, "task", task?.span.id);
      expect(tool).toHaveLength(1);
      const subagent = findChildSpans(
        events,
        "Cursor Subagent",
        tool[0].span.id,
      );
      expect(subagent).toHaveLength(1);
      expect(JSON.stringify(subagent[0].row.output)).toContain(
        "CURSOR_SUBAGENT_OK",
      );
      for (const event of [shell[0], tool[0], subagent[0]]) {
        expect(event.row.error).toBeUndefined();
      }
      const waitTask = findCursorTask(events, "cursor-sdk-wait-operation");
      for (const callback of ["on-delta", "on-step"]) {
        expect(
          findChildSpans(
            events,
            `cursor-sdk-user-${callback}`,
            waitTask?.span.id,
          ).length,
        ).toBeGreaterThan(0);
      }
    });

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
