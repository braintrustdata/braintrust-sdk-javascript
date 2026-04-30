import { beforeAll, describe, expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import {
  findAllSpans,
  findChildSpans,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunCursorSDKScenario = (harness: {
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

const METADATA_KEYS = [
  "provider",
  "model",
  "operation",
  "scenario",
  "gen_ai.tool.name",
  "cursor_sdk.model",
  "cursor_sdk.operation",
  "cursor_sdk.agent_id",
  "cursor_sdk.run_id",
  "cursor_sdk.runtime",
  "cursor_sdk.status",
  "cursor_sdk.duration_ms",
  "cursor_sdk.step_types",
  "cursor_sdk.tool.status",
] as const;

function summarizeSpan(event: CapturedLogEvent | undefined): Json {
  if (!event) {
    return null;
  }
  const summary = summarizeWrapperContract(event, [...METADATA_KEYS]) as Record<
    string,
    Json
  >;
  if (summary.metadata && typeof summary.metadata === "object") {
    const metadata = summary.metadata as Record<string, Json>;
    if (typeof metadata["cursor_sdk.agent_id"] === "string") {
      metadata["cursor_sdk.agent_id"] = "<agent-id>";
    }
    if (typeof metadata["cursor_sdk.run_id"] === "string") {
      metadata["cursor_sdk.run_id"] = "<run-id>";
    }
    if (typeof metadata["cursor_sdk.duration_ms"] === "number") {
      metadata["cursor_sdk.duration_ms"] = 1;
    }
  }
  if (typeof event.row.error === "string") {
    summary.error = event.row.error;
  }
  return summary;
}

function findOperation(events: CapturedLogEvent[], name: string) {
  return findLatestSpan(events, name);
}

function findCursorTask(events: CapturedLogEvent[], operationName: string) {
  const operation = findOperation(events, operationName);
  return findChildSpans(events, "Cursor Agent", operation?.span.id).at(-1);
}

function outputText(event: CapturedLogEvent | undefined): string {
  return typeof event?.output === "string" ? event.output : "";
}

function summarize(events: CapturedLogEvent[]): Json {
  const promptTask = findCursorTask(events, "cursor-sdk-prompt-operation");
  const streamTask = findCursorTask(events, "cursor-sdk-stream-operation");
  const waitTask = findCursorTask(events, "cursor-sdk-wait-operation");
  const conversationTask = findCursorTask(
    events,
    "cursor-sdk-resume-conversation-operation",
  );
  const tool = findAllSpans(events, "tool: shell").at(-1);
  const subagentTask = events.find(
    (event) =>
      event.span.type === "task" && event.span.name?.startsWith("Agent:"),
  );

  return normalizeForSnapshot({
    conversation: {
      operation: summarizeSpan(
        findOperation(events, "cursor-sdk-resume-conversation-operation"),
      ),
      task: summarizeSpan(conversationTask),
    },
    prompt: {
      operation: summarizeSpan(
        findOperation(events, "cursor-sdk-prompt-operation"),
      ),
      task: summarizeSpan(promptTask),
    },
    root: summarizeSpan(findLatestSpan(events, ROOT_NAME)),
    stream: {
      operation: summarizeSpan(
        findOperation(events, "cursor-sdk-stream-operation"),
      ),
      subagent_task: summarizeSpan(subagentTask),
      task: summarizeSpan(streamTask),
      tool: summarizeSpan(tool),
    },
    wait: {
      operation: summarizeSpan(
        findOperation(events, "cursor-sdk-wait-operation"),
      ),
      task: summarizeSpan(waitTask),
    },
  } as Json);
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
    `${options.snapshotName}.span-events.json`,
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

    test("captures the root trace", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
    });

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
          expect(task).toBeDefined();
          expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
          expect(task?.row.metadata).toMatchObject({
            provider: "cursor",
          });
        }
      },
    );

    test(
      "captures tool spans when Cursor surfaces tool calls",
      testConfig,
      () => {
        const streamTask = findCursorTask(
          events,
          "cursor-sdk-stream-operation",
        );
        const toolSpans = events.filter(
          (event) =>
            event.span.type === "tool" &&
            event.span.parentIds.includes(streamTask?.span.id ?? ""),
        );

        expect(toolSpans.length).toBeGreaterThan(0);
        expect(
          toolSpans.some(
            (event) =>
              event.input !== undefined &&
              event.output !== undefined &&
              event.metadata?.["cursor_sdk.tool.status"] === "completed",
          ),
        ).toBe(true);
        expect(
          JSON.stringify(toolSpans.map((event) => event.output)),
        ).toContain("cursor_tool_ok");
      },
    );

    test("preserves user onDelta/onStep callbacks", testConfig, () => {
      expect(findLatestSpan(events, "cursor-sdk-user-on-delta")).toBeDefined();
      expect(findLatestSpan(events, "cursor-sdk-user-on-step")).toBeDefined();

      const waitTask = findCursorTask(events, "cursor-sdk-wait-operation");
      expect(waitTask?.metrics).toMatchObject({
        completion_tokens: expect.any(Number),
        prompt_tokens: expect.any(Number),
      });
      expect(waitTask?.metrics?.["cursor_sdk.step_duration_ms"]).toEqual(
        expect.any(Number),
      );
      expect(outputText(waitTask)).toContain("CURSOR_WAIT_OK");
    });

    test("captures conversation output text", testConfig, () => {
      const conversationTask = findCursorTask(
        events,
        "cursor-sdk-resume-conversation-operation",
      );

      expect(outputText(conversationTask)).toContain("CURSOR_CONVERSATION_OK");
    });

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(summarize(events)),
      ).toMatchFileSnapshot(snapshotPath);
    });
  });
}
