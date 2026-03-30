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

type RunClaudeAgentSDKScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const SNAPSHOT_METADATA_KEYS = [
  "provider",
  "model",
  "operation",
  "scenario",
  "mcp.server",
  "gen_ai.tool.name",
] as const;
const OMITTED_METRIC_KEYS = new Set([
  "prompt_cached_tokens",
  "prompt_cache_creation_tokens",
]);

function summarizeSpan(
  event: CapturedLogEvent | undefined,
  overrides?: {
    metadata?: Json;
    name?: string | null;
  },
): Json {
  if (!event) {
    return null;
  }

  const summary = summarizeWrapperContract(event, [
    ...SNAPSHOT_METADATA_KEYS,
  ]) as Record<string, Json>;
  const metricKeys = Array.isArray(summary.metric_keys)
    ? summary.metric_keys.filter(
        (key): key is string =>
          typeof key === "string" && !OMITTED_METRIC_KEYS.has(key),
      )
    : summary.metric_keys;
  const input = event.input as
    | Array<{ content?: string; message?: { content?: string } }>
    | undefined;
  const inputContents =
    Array.isArray(input) &&
    input
      .map((item) => item.message?.content ?? item.content)
      .filter((content): content is string => typeof content === "string");

  if (overrides?.metadata !== undefined) {
    summary.metadata = overrides.metadata;
  }
  if (overrides?.name !== undefined) {
    summary.name = overrides.name;
  }
  if (typeof event.row.error === "string") {
    summary.error = event.row.error;
  }
  if (metricKeys !== undefined) {
    summary.metric_keys = metricKeys;
  }
  if (Array.isArray(inputContents) && inputContents.length > 0) {
    summary.input_contents = inputContents;
  }

  return summary;
}

function buildSpanSummary(events: CapturedLogEvent[]): Json {
  const root = findLatestSpan(events, ROOT_NAME);
  const basicOperation = findLatestSpan(events, "claude-agent-basic-operation");
  const asyncPromptOperation = findLatestSpan(
    events,
    "claude-agent-async-prompt-operation",
  );
  const subAgentOperation = findLatestSpan(
    events,
    "claude-agent-subagent-operation",
  );
  const failureOperation = findLatestSpan(
    events,
    "claude-agent-failure-operation",
  );

  const basicTask = findChildSpans(
    events,
    "Claude Agent",
    basicOperation?.span.id,
  ).at(-1);
  const asyncPromptTask = findChildSpans(
    events,
    "Claude Agent",
    asyncPromptOperation?.span.id,
  ).at(-1);
  const subAgentTaskRoot = findChildSpans(
    events,
    "Claude Agent",
    subAgentOperation?.span.id,
  ).at(-1);
  const failureTask = findChildSpans(
    events,
    "Claude Agent",
    failureOperation?.span.id,
  ).at(-1);

  const basicLlm = findChildSpans(
    events,
    "anthropic.messages.create",
    basicTask?.span.id,
  ).at(-1);
  const asyncPromptLlm = findChildSpans(
    events,
    "anthropic.messages.create",
    asyncPromptTask?.span.id,
  ).find((event) => {
    const input = event.input as Array<{ content?: string }> | undefined;
    return Array.isArray(input) && input.some((item) => item.content);
  });
  const subAgentLlm = findAllSpans(events, "anthropic.messages.create").find(
    (event) => event.span.parentIds.includes(subAgentTaskRoot?.span.id ?? ""),
  );
  const failureLlm = findChildSpans(
    events,
    "anthropic.messages.create",
    failureTask?.span.id,
  ).at(-1);

  const basicTool = findAllSpans(events, "tool: calculator/calculator").find(
    (event) => event.span.parentIds.includes(basicTask?.span.id ?? ""),
  );
  const subAgentTask = events.find(
    (event) =>
      event.span.type === "task" &&
      event.span.parentIds.includes(subAgentTaskRoot?.span.id ?? "") &&
      event.span.name?.startsWith("Agent:"),
  );
  const subAgentTool = findAllSpans(events, "tool: calculator/calculator").find(
    (event) => event.span.parentIds.includes(subAgentTask?.span.id ?? ""),
  );
  const failureTool = findAllSpans(events, "tool: calculator/calculator").find(
    (event) => event.span.parentIds.includes(failureTask?.span.id ?? ""),
  );

  return normalizeForSnapshot({
    async_prompt: {
      llm: summarizeSpan(asyncPromptLlm),
      operation: summarizeSpan(asyncPromptOperation),
      task: summarizeSpan(asyncPromptTask),
    },
    basic: {
      llm: summarizeSpan(basicLlm),
      operation: summarizeSpan(basicOperation),
      task: summarizeSpan(basicTask),
      tool: summarizeSpan(basicTool),
    },
    failure: {
      llm: summarizeSpan(failureLlm),
      operation: summarizeSpan(failureOperation),
      task: summarizeSpan(failureTask),
      tool: summarizeSpan(failureTool),
    },
    root: summarizeSpan(root),
    subagent: {
      llm: summarizeSpan(subAgentLlm),
      nested_task: summarizeSpan(subAgentTask),
      operation: summarizeSpan(subAgentOperation),
      task_root: summarizeSpan(subAgentTaskRoot),
      tool: summarizeSpan(subAgentTool),
    },
  } as Json);
}

export function defineClaudeAgentSDKInstrumentationAssertions(options: {
  name: string;
  runScenario: RunClaudeAgentSDKScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-events.json`,
  );
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

    test("captures tool-backed task and llm spans", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);
      const operation = findLatestSpan(events, "claude-agent-basic-operation");
      const task = findChildSpans(
        events,
        "Claude Agent",
        operation?.span.id,
      ).at(-1);
      const llm = findChildSpans(
        events,
        "anthropic.messages.create",
        task?.span.id,
      ).at(-1);
      const tool = findAllSpans(events, "tool: calculator/calculator").find(
        (event) => event.span.parentIds.includes(task?.span.id ?? ""),
      );

      expect(operation).toBeDefined();
      expect(task).toBeDefined();
      expect(llm).toBeDefined();
      expect(tool).toBeDefined();
      expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
      expect(tool?.span.parentIds).toEqual([task?.span.id ?? ""]);
    });

    test(
      "captures async prompt input on both task and llm spans",
      testConfig,
      () => {
        const operation = findLatestSpan(
          events,
          "claude-agent-async-prompt-operation",
        );
        const task = findChildSpans(
          events,
          "Claude Agent",
          operation?.span.id,
        ).at(-1);
        const llm = findChildSpans(
          events,
          "anthropic.messages.create",
          task?.span.id,
        ).find((event) => {
          const input = event.input as Array<{ content?: string }> | undefined;
          return Array.isArray(input) && input.some((item) => item.content);
        });

        expect(operation).toBeDefined();
        expect(task).toBeDefined();
        expect(task?.input).toMatchObject([
          { message: { content: "Part 1" } },
          { message: { content: "Part 2" } },
        ]);
        expect(llm?.input).toMatchObject([
          { content: "Part 1" },
          { content: "Part 2" },
        ]);
      },
    );

    test("captures nested subagent task hierarchy", testConfig, () => {
      const operation = findLatestSpan(
        events,
        "claude-agent-subagent-operation",
      );
      const taskRoot = findChildSpans(
        events,
        "Claude Agent",
        operation?.span.id,
      ).at(-1);
      const llm = findAllSpans(events, "anthropic.messages.create").find(
        (event) => event.span.parentIds.includes(taskRoot?.span.id ?? ""),
      );
      const nestedTask = events.find(
        (event) =>
          event.span.type === "task" &&
          event.span.parentIds.includes(taskRoot?.span.id ?? "") &&
          event.span.name?.startsWith("Agent:"),
      );
      const tool = findAllSpans(events, "tool: calculator/calculator").find(
        (event) => event.span.parentIds.includes(nestedTask?.span.id ?? ""),
      );

      expect(operation).toBeDefined();
      expect(taskRoot).toBeDefined();
      expect(llm).toBeDefined();
      expect(nestedTask).toBeDefined();
      if (tool) {
        expect(tool.span.parentIds).toContain(nestedTask?.span.id ?? "");
        expect(tool.span.parentIds).not.toContain(taskRoot?.span.id ?? "");
      }
    });

    test("captures tool failure details", testConfig, () => {
      const operation = findLatestSpan(
        events,
        "claude-agent-failure-operation",
      );
      const task = findChildSpans(
        events,
        "Claude Agent",
        operation?.span.id,
      ).at(-1);
      const llm = findChildSpans(
        events,
        "anthropic.messages.create",
        task?.span.id,
      ).at(-1);
      const tool = findAllSpans(events, "tool: calculator/calculator").find(
        (event) => event.span.parentIds.includes(task?.span.id ?? ""),
      );

      expect(operation).toBeDefined();
      expect(task).toBeDefined();
      expect(llm).toBeDefined();
      if (tool) {
        expect(tool.row.error).toBe("division by zero");
      }
    });

    test("matches the shared span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildSpanSummary(events)),
      ).toMatchFileSnapshot(snapshotPath);
    });
  });
}
