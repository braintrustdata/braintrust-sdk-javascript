import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { withScenarioHarness } from "../../helpers/scenario-harness";
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
  runScenario: RunOpenAIAgentsScenario;
  timeoutMs: number;
}): void {
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
      { timeout: options.timeoutMs },
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(events, OPERATION_NAME);
        const workflow = findLatestChildSpan(
          events,
          "Agent workflow",
          operation?.span.id,
        );
        const agent = findLatestChildSpan(
          events,
          AGENT_NAME,
          workflow?.span.id,
        );
        const modelSpans = findModelSpans(events, agent?.span.id);
        const toolSpan = findLatestChildSpan(events, TOOL_NAME, agent?.span.id);

        expect(root).toBeDefined();
        expect(root?.row.metadata).toMatchObject({
          scenario: SCENARIO_NAME,
        });
        expect(operation).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);

        expect(workflow).toBeDefined();
        expect(workflow?.span.type).toBe("task");
        expect(workflow?.span.parentIds).toEqual([operation?.span.id ?? ""]);

        expect(agent).toBeDefined();
        expect(agent?.span.type).toBe("task");
        expect(agent?.row.metadata).toMatchObject({
          tools: [TOOL_NAME],
          output_type: "text",
        });

        expect(modelSpans.length).toBeGreaterThanOrEqual(1);
        for (const modelSpan of modelSpans) {
          expect(modelSpan.span.type).toBe("llm");
          expect(String(modelSpan.row.metadata?.model)).toContain(MODEL_NAME);
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
  });
}
