import { beforeAll, describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findChildSpans,
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import {
  AGENT_NAME,
  FINAL_OUTPUT,
  MODEL_NAME,
  OPERATION_NAME,
  ROOT_NAME,
  SCENARIO_NAME,
  TOOL_NAME,
} from "./constants.mjs";

type RunOpenAIAgentsScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function findModelSpans(
  events: CapturedLogEvent[],
  parentId: string | undefined,
): CapturedLogEvent[] {
  return [
    ...findChildSpans(events, "Response", parentId),
    ...findChildSpans(events, "Generation", parentId),
  ];
}

export function defineOpenAIAgentsAutoInstrumentationAssertions(options: {
  name: string;
  hasTurnSpans: boolean;
  runScenario: RunOpenAIAgentsScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const testConfig = { timeout: options.timeoutMs };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, options.timeoutMs);

    test(
      "captures OpenAI Agents spans through the auto-hook setup",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(events, OPERATION_NAME);
        const workflow = findLatestChildSpan(
          events,
          "Agent workflow",
          operation?.span.id,
        );
        const task = options.hasTurnSpans
          ? findLatestChildSpan(events, "Agent workflow", workflow?.span.id)
          : workflow;
        const agent = findLatestChildSpan(events, AGENT_NAME, task?.span.id);
        const turns = findChildSpans(events, "Turn", agent?.span.id);
        const modelSpans = options.hasTurnSpans
          ? turns.flatMap((turn) => findModelSpans(events, turn.span.id))
          : findModelSpans(events, agent?.span.id);
        const toolSpan = findLatestChildSpan(
          events,
          TOOL_NAME,
          options.hasTurnSpans ? turns[0]?.span.id : agent?.span.id,
        );

        expect(root).toBeDefined();
        expect(root?.row.metadata).toMatchObject({
          scenario: SCENARIO_NAME,
        });
        expect(operation).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);

        expect(workflow).toBeDefined();
        expect(workflow?.span.type).toBe("task");
        expect(workflow?.span.parentIds).toEqual([operation?.span.id ?? ""]);

        if (options.hasTurnSpans) {
          expect(task?.span.type).toBe("task");
          expect(task?.span.parentIds).toEqual([workflow?.span.id]);
          expect(turns).toHaveLength(2);
          for (const [index, turn] of turns.entries()) {
            expect(turn.span.type).toBe("task");
            expect(turn.row.metadata).toMatchObject({
              turn: index + 1,
              agent_name: AGENT_NAME,
            });
            expect(findModelSpans(events, turn.span.id)).toHaveLength(1);
          }
          for (const parent of [task, ...turns]) {
            const children =
              parent === task
                ? modelSpans
                : findModelSpans(events, parent?.span.id);
            for (const metric of [
              "prompt_tokens",
              "completion_tokens",
              "tokens",
            ]) {
              expect(parent?.metrics?.[metric]).toBe(
                children.reduce(
                  (sum, child) => sum + (child.metrics?.[metric] as number),
                  0,
                ),
              );
            }
          }
        }

        expect(agent).toBeDefined();
        expect(agent?.span.type).toBe("task");
        expect(agent?.row.metadata).toMatchObject({
          tools: [TOOL_NAME],
          output_type: "text",
        });

        expect(modelSpans.length).toBeGreaterThanOrEqual(1);
        for (const modelSpan of modelSpans) {
          expect(modelSpan.span.type).toBe("llm");
          expect(modelSpan.row.metadata).toMatchObject({
            model: expect.stringContaining(MODEL_NAME),
          });
          expect(modelSpan.metrics).toMatchObject({
            completion_tokens: expect.any(Number),
            prompt_tokens: expect.any(Number),
            tokens: expect.any(Number),
          });
          expect(modelSpan.input).toEqual(
            expect.arrayContaining([expect.anything()]),
          );
          expect(modelSpan.output).toBeDefined();
        }

        expect(toolSpan).toBeDefined();
        expect(toolSpan?.span.type).toBe("tool");
        expect(toolSpan?.input).toBe(JSON.stringify({ city: "Vienna" }));
        expect(toolSpan?.output).toBe(FINAL_OUTPUT);
      },
    );

    test("matches the span tree snapshot", testConfig, async ({ expect }) => {
      await matchSpanTreeSnapshot(events, spanSnapshotPath, {
        snapshotExpect: expect,
      });
    });
  });
}
