import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { CHAT_MODEL, ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

const CHAT_MODEL_NAME = CHAT_MODEL.split("/").at(-1) ?? CHAT_MODEL;
const OPENROUTER_MODEL_PROVIDER = "openai";

type RunOpenRouterAgentScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

function findOpenRouterSpans(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: string[],
) {
  for (const name of names) {
    const spans = findChildSpans(events, name, parentId);
    if (spans.length > 0) {
      return spans;
    }
  }

  return [];
}

function findOpenRouterSpan(
  events: CapturedLogEvent[],
  parentId: string | undefined,
  names: string[],
) {
  const spans = findOpenRouterSpans(events, parentId, names);
  return spans.find((candidate) => candidate.output !== undefined) ?? spans[0];
}

export function defineOpenRouterAgentTraceAssertions(options: {
  name: string;
  runScenario: RunOpenRouterAgentScenario;
  timeoutMs: number;
}): void {
  const testConfig = {
    timeout: options.timeoutMs,
  };

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, options.timeoutMs);

    test("captures the root trace for the scenario", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    test(
      "captures trace for client.callModel(request) and nested tool/turn spans",
      testConfig,
      () => {
        const root = findLatestSpan(events, ROOT_NAME);
        const operation = findLatestSpan(
          events,
          "openrouter-agent-call-model-operation",
        );
        const span = findOpenRouterSpan(events, operation?.span.id, [
          "openrouter.callModel",
        ]);
        const nestedLlmSpans = findOpenRouterSpans(events, span?.span.id, [
          "openrouter.beta.responses.send",
        ]);
        const nestedToolSpan = findOpenRouterSpan(events, span?.span.id, [
          "lookup_weather",
          "openrouter.tool",
        ]);

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
        expect(span?.span.type).toBe("llm");
        expect(span?.row.metadata).toMatchObject({
          provider: OPENROUTER_MODEL_PROVIDER,
        });
        expect(String(span?.row.metadata?.model)).toContain(CHAT_MODEL_NAME);
        expect(span?.output).toBeDefined();

        expect(nestedLlmSpans.length).toBeGreaterThanOrEqual(2);
        for (const [index, nestedLlmSpan] of nestedLlmSpans.entries()) {
          expect(nestedLlmSpan?.span.type).toBe("llm");
          expect(nestedLlmSpan?.row.metadata).toMatchObject({
            provider: OPENROUTER_MODEL_PROVIDER,
            step: index + 1,
          });
          expect(String(nestedLlmSpan?.row.metadata?.model)).toContain(
            CHAT_MODEL_NAME,
          );
          expect(nestedLlmSpan?.output).toBeDefined();
        }

        expect(nestedToolSpan).toBeDefined();
        expect(nestedToolSpan?.span.type).toBe("tool");
        expect(nestedToolSpan?.input).toMatchObject({
          city: "Vienna",
        });
        expect(nestedToolSpan?.row.metadata).toMatchObject({
          provider: "openrouter",
          tool_name: "lookup_weather",
        });
        expect(nestedToolSpan?.output).toMatchObject({
          forecast: "Sunny in Vienna",
        });
      },
    );
  });
}
