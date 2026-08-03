import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
} from "../../helpers/span-tree";
import {
  findAllSpans,
  findLatestChildSpan,
} from "../../helpers/trace-selectors";

function latestSpan(events: CapturedLogEvent[], name: string) {
  return [...events].reverse().find((event) => event.span.name === name);
}

export function defineFlueV2InstrumentationAssertions(options: {
  originalScenarioDir: string;
  runtimePackageName: string;
  scenarioDir: string;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);
  const testConfig = { timeout: timeoutMs };
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );

  describe.sequential("explicit native instrumentation", () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runScenarioDir({
          entry: "scenario.v2.ts",
          env: {
            FLUE_RUNTIME_PACKAGE_NAME: options.runtimePackageName,
          },
          runContext: {
            originalScenarioDir: options.originalScenarioDir,
            variantKey: options.snapshotName,
          },
          scenarioDir: options.scenarioDir,
          timeoutMs,
        });
        events = harness.events();
      });
    }, timeoutMs);

    test("captures the Flue 2 agentic span hierarchy", testConfig, () => {
      const operation = latestSpan(events, "flue.prompt");
      const llmSpans = findAllSpans(events, "flue.turn");
      const tool = latestSpan(events, "tool:lookup");
      const probe = findLatestChildSpan(
        events,
        "flue.toolCurrentProbe",
        tool?.span.id,
      );

      expect(operation).toBeDefined();
      expect(operation?.span.type).toBe("task");
      expect(operation?.input).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "user" })]),
      );
      expect(operation?.output).toBe("PROMPT_DONE");
      expect(operation?.row.metadata).toMatchObject({
        "flue.agent_name": "InstrumentedAgent",
        "flue.instance_id": "braintrust-e2e",
        provider: "flue",
      });

      expect(llmSpans).toHaveLength(2);
      for (const llmSpan of llmSpans) {
        expect(llmSpan.span.parentIds).toEqual([operation?.span.id]);
        expect(llmSpan.span.type).toBe("llm");
        expect(llmSpan.row.metadata).toMatchObject({
          "flue.api": "openai-responses",
          "flue.model": "gpt-5.6-luna",
          "flue.provider": "openai",
          model: "gpt-5.6-luna",
          provider: "openai",
          reasoning: "low",
        });
        expect(llmSpan.metrics).toMatchObject({
          completion_tokens: expect.any(Number),
          prompt_tokens: expect.any(Number),
          tokens: expect.any(Number),
        });
      }

      expect(tool?.span.parentIds).toEqual([operation?.span.id]);
      expect(tool?.input).toEqual({ query: "Flue 2 instrumentation" });
      expect(tool?.output).toEqual({
        framework: "flue",
        query: "Flue 2 instrumentation",
        version: 2,
      });
      expect(probe?.span.parentIds).toEqual([tool?.span.id]);
      expect(probe?.output).toBe("lookup-active");
    });

    test("matches the Flue 2 span tree snapshot", testConfig, async () => {
      const operation = latestSpan(events, "flue.prompt");
      const tool = latestSpan(events, "tool:lookup");
      const entries: SpanTreeEntry[] = [
        operation,
        ...findAllSpans(events, "flue.turn"),
        tool,
        findLatestChildSpan(events, "flue.toolCurrentProbe", tool?.span.id),
      ]
        .filter((event): event is CapturedLogEvent => event !== undefined)
        .map((event) => ({
          event,
          fields: {
            ...spanTreeFields(event),
            context: event.context,
          },
        }));

      await matchSpanTreeSnapshot(entries, snapshotPath, {
        normalize: {
          additionalProviderIdKeys: [
            "flue.conversation_id",
            "flue.operation_id",
            "flue.submission_id",
            "flue.tool_call_id",
            "flue.turn_id",
          ],
        },
      });
    });
  });
}
