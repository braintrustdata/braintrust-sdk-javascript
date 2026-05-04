import { beforeAll, describe, expect, test } from "vitest";
import { E2E_TAGS } from "../../helpers/tags";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunOpenAICodexScenario = (harness: {
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
  "openai_codex.operation",
  "openai_codex.model",
  "openai_codex.thread_id",
  "openai_codex.item_type",
  "openai_codex.command.status",
  "openai_codex.mcp.server",
  "openai_codex.mcp.status",
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
    if (typeof metadata["openai_codex.thread_id"] === "string") {
      metadata["openai_codex.thread_id"] = "<thread-id>";
    }
  }
  return summary;
}

function findCodexTask(events: CapturedLogEvent[], operationName: string) {
  const operation = findLatestSpan(events, operationName);
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.span.name === "OpenAI Codex" &&
        event.span.parentIds.includes(operation?.span.id ?? ""),
    );
}

function latestSpansByType(
  events: CapturedLogEvent[],
  type: string,
): CapturedLogEvent[] {
  const order: string[] = [];
  const latest = new Map<string, CapturedLogEvent>();

  for (const event of events) {
    if (event.span.type !== type || !event.span.id) {
      continue;
    }
    if (!latest.has(event.span.id)) {
      order.push(event.span.id);
    }
    latest.set(event.span.id, event);
  }

  return order.flatMap((spanId) => {
    const event = latest.get(spanId);
    return event ? [event] : [];
  });
}

function summarize(events: CapturedLogEvent[]): Json {
  const runTask = findCodexTask(events, "openai-codex-run-operation");
  const streamedTask = findCodexTask(
    events,
    "openai-codex-run-streamed-operation",
  );
  const toolSpans = latestSpansByType(events, "tool");

  return normalizeForSnapshot({
    root: summarizeSpan(findLatestSpan(events, ROOT_NAME)),
    run: {
      operation: summarizeSpan(
        findLatestSpan(events, "openai-codex-run-operation"),
      ),
      task: summarizeSpan(runTask),
    },
    streamed: {
      operation: summarizeSpan(
        findLatestSpan(events, "openai-codex-run-streamed-operation"),
      ),
      task: summarizeSpan(streamedTask),
    },
    tools: toolSpans.map(summarizeSpan),
  } as Json);
}

export function defineOpenAICodexInstrumentationAssertions(options: {
  name: string;
  runScenario: RunOpenAICodexScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-events.json`,
  );
  const testConfig = {
    tags: [E2E_TAGS.hermetic],
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

    test("captures the root trace", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
    });

    test("captures Codex task spans", testConfig, () => {
      for (const operationName of [
        "openai-codex-run-operation",
        "openai-codex-run-streamed-operation",
      ]) {
        const operation = findLatestSpan(events, operationName);
        const task = findCodexTask(events, operationName);

        expect(operation).toBeDefined();
        expect(task).toBeDefined();
        expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
        expect(task?.row.metadata).toMatchObject({
          provider: "openai",
        });
      }
    });

    test("captures command and MCP tool spans", testConfig, () => {
      const toolSpans = latestSpansByType(events, "tool");

      expect(
        toolSpans.some(
          (event) =>
            event.span.name === "tool: command_execution" &&
            event.output === "codex_tool_ok",
        ),
      ).toBe(true);
      expect(
        toolSpans.some(
          (event) =>
            event.span.name === "tool: read_file" &&
            event.metadata?.["openai_codex.mcp.server"] === "filesystem",
        ),
      ).toBe(true);
    });

    test("captures final responses and usage metrics", testConfig, () => {
      const runTask = findCodexTask(events, "openai-codex-run-operation");
      const streamedTask = findCodexTask(
        events,
        "openai-codex-run-streamed-operation",
      );

      expect(runTask?.output).toContain("RUN_OK");
      expect(streamedTask?.output).toContain("STREAM_OK");
      expect(runTask?.metrics).toMatchObject({
        completion_tokens: 7,
        prompt_cached_tokens: 3,
        prompt_tokens: 11,
      });
    });

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(summarize(events)),
      ).toMatchFileSnapshot(snapshotPath);
    });
  });
}
