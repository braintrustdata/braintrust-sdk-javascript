import { beforeAll, describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import {
  CORRELATION_ID,
  CORRELATION_KEY,
  FINAL_OUTPUT,
  INPUT,
  MODEL_NAME,
  ROOT_NAME,
  SCENARIO_NAME,
  TOOL_NAME,
} from "./constants.mjs";

type RunOpenAIAgentsAPIScenario = (harness: {
  runScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

export function defineOpenAIAgentsAPIInstrumentationAssertions(options: {
  name: string;
  runScenario: RunOpenAIAgentsAPIScenario;
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

    test("captures the asynchronous Agents API turn", testConfig, () => {
      const scenarioRoot = findLatestSpan(events, ROOT_NAME);
      const turn = findLatestChildSpan(
        events,
        "openai.agents.turn",
        scenarioRoot?.span.id,
      );
      const tool = findLatestChildSpan(events, TOOL_NAME, turn?.span.id);

      expect(scenarioRoot?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
      expect(turn).toBeDefined();
      expect(turn?.span.type).toBe("task");
      expect(turn?.input).toBe(INPUT);
      expect(String(turn?.output)).toContain(FINAL_OUTPUT);
      expect(turn?.row.metadata).toMatchObject({
        [CORRELATION_KEY]: CORRELATION_ID,
        api: "agents",
        model: MODEL_NAME,
        provider: "openai",
        session_id: expect.any(String),
      });
      expect(turn?.metrics).toMatchObject({
        time_to_first_token: expect.any(Number),
      });
      expect(tool).toBeDefined();
      expect(tool?.span.type).toBe("tool");
      expect(tool?.output).toBeDefined();
      expect(tool?.row.metadata).toMatchObject({
        provider: "openai",
        tool_type: "web_search_call",
      });
      expect(events.some((event) => event.span.type === "llm")).toBe(false);
    });

    test("matches the span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(events, spanSnapshotPath);
    });
  });
}
