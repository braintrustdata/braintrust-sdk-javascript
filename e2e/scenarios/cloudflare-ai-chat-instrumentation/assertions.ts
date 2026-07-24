import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { findAllSpans, findLatestSpan } from "../../helpers/trace-selectors";

const ERROR_ROOT_NAME = "cloudflare-ai-chat-error-root";
const SUCCESS_ROOT_NAME = "cloudflare-ai-chat-success-root";
const TASK_NAME = "AIChatAgent.onChatMessage";

type RunScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

export function defineCloudflareAIChatAssertions(options: {
  name: string;
  runScenario: RunScenario;
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
    let setupError: string | undefined;

    beforeAll(async () => {
      try {
        await withScenarioHarness(async (harness) => {
          await options.runScenario(harness);
          events = harness.events();
        });
      } catch (error) {
        setupError = error instanceof Error ? error.message : String(error);
      }
    }, timeoutMs);

    test("captures complete task, model, and tool spans", testConfig, () => {
      expect(setupError).toBeUndefined();
      const root = findLatestSpan(events, SUCCESS_ROOT_NAME);
      const task = findAllSpans(events, TASK_NAME).find((candidate) =>
        sameTrace(candidate, root),
      );
      const generate = spansInRoot(events, root, "generateText")[0];
      const llmSpans = spansInRoot(events, root, "doGenerate");
      const toolSpan = spansInRoot(events, root, "lookup_weather")[0];

      expect(root?.metadata).toMatchObject({
        scenario: "cloudflare-ai-chat-instrumentation",
      });
      expect(task).toBeDefined();
      expect(task?.span.type).toBe("task");
      expect(task?.input).toEqual([
        {
          id: "user-success",
          parts: [{ text: "Look up the weather in Vienna.", type: "text" }],
          role: "user",
        },
      ]);
      expect(JSON.stringify(task?.output)).toContain(
        "CLOUDFLARE_AI_CHAT_TOOL_OK",
      );
      expect(generate?.span.parentIds).toContain(task?.span.id);
      expect(llmSpans).toHaveLength(2);
      expect(llmSpans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({
              model: "gpt-4.1-nano",
              provider: expect.stringContaining("openai"),
            }),
            metrics: expect.objectContaining({ tokens: expect.any(Number) }),
          }),
        ]),
      );
      expect(toolSpan).toMatchObject({
        input: { city: "Vienna" },
        output: expect.objectContaining({ marker: "WEATHER_TOOL_EXECUTED" }),
        span: { type: "tool" },
      });
    });

    test("captures and closes streaming failures", testConfig, () => {
      expect(setupError).toBeUndefined();
      const root = findLatestSpan(events, ERROR_ROOT_NAME);
      const task = findAllSpans(events, TASK_NAME).find((candidate) =>
        sameTrace(candidate, root),
      );

      expect(root).toBeDefined();
      expect(task?.span.ended).toBe(true);
      expect(JSON.stringify(task?.output)).toContain("partial response");
      expect(String(task?.row.error)).toContain(
        "CLOUDFLARE_AI_CHAT_STREAM_ERROR",
      );
    });

    test("matches the stable trace contract", testConfig, async () => {
      expect(setupError).toBeUndefined();
      const roots = [
        findLatestSpan(events, SUCCESS_ROOT_NAME),
        findLatestSpan(events, ERROR_ROOT_NAME),
      ].filter((event): event is CapturedLogEvent => event !== undefined);
      const rootIds = new Set(roots.map((root) => root.span.rootId));
      const selected = [
        ...roots,
        ...findAllSpans(events, TASK_NAME),
        ...findAllSpans(events, "generateText"),
        ...findAllSpans(events, "doGenerate"),
        ...findAllSpans(events, "lookup_weather"),
      ].filter((event) => rootIds.has(event.span.rootId));

      await matchSpanTreeSnapshot(
        selected.map((event) => ({ event, fields: spanTreeFields(event) })),
        snapshotPath,
        { snapshotExpect: expect },
      );
    });
  });
}

function spansInRoot(
  events: CapturedLogEvent[],
  root: CapturedLogEvent | undefined,
  name: string,
): CapturedLogEvent[] {
  return findAllSpans(events, name).filter((event) => sameTrace(event, root));
}

function sameTrace(
  event: CapturedLogEvent,
  root: CapturedLogEvent | undefined,
): boolean {
  return event.span.rootId === root?.span.rootId;
}
