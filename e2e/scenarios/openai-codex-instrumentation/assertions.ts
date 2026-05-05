import { beforeAll, describe, expect, test } from "vitest";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { E2E_TAGS } from "../../helpers/tags";
import { findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunOpenAICodexScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    nodeArgs: string[];
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

type CodexScenarioMode = "mock" | "real";

const OPERATION_NAMES = [
  "openai-codex-run-operation",
  "openai-codex-run-streamed-operation",
] as const;

const EXPECTED_MARKERS = {
  "openai-codex-run-operation": "OPENAI_CODEX_RUN_OK",
  "openai-codex-run-streamed-operation": "OPENAI_CODEX_STREAM_OK",
} as const;

const METADATA_KEYS = [
  "provider",
  "model",
  "operation",
  "scenario",
  "gen_ai.tool.name",
  "openai_codex.llm_sequence",
  "openai_codex.operation",
  "openai_codex.model",
  "openai_codex.thread_id",
  "openai_codex.item_type",
  "openai_codex.command.status",
  "openai_codex.mcp.server",
  "openai_codex.mcp.status",
] as const;

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

function latestSpansForParent(
  events: CapturedLogEvent[],
  parentSpanId: string | undefined,
): CapturedLogEvent[] {
  if (!parentSpanId) {
    return [];
  }

  const order: string[] = [];
  const latest = new Map<string, CapturedLogEvent>();

  for (const event of events) {
    if (!event.span.id || !event.span.parentIds.includes(parentSpanId)) {
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

function expectPositiveMetric(
  event: CapturedLogEvent | undefined,
  keys: string[],
): void {
  const hasPositiveMetric = keys.some((key) => {
    const value = event?.metrics?.[key];
    return typeof value === "number" && value > 0;
  });

  expect(hasPositiveMetric).toBe(true);
}

function outputText(event: CapturedLogEvent | undefined): string {
  return typeof event?.output === "string"
    ? event.output
    : JSON.stringify(event?.output ?? "");
}

function sequenceNumber(event: CapturedLogEvent): number | undefined {
  const value = event.metadata?.["openai_codex.llm_sequence"];
  return typeof value === "number" ? value : undefined;
}

function childSpanLabel(event: CapturedLogEvent): string {
  return event.span.type === "llm" ? "llm" : (event.span.name ?? "");
}

function llmOutput(event: CapturedLogEvent): {
  message?: string;
  reasoning?: string;
} {
  return event.output &&
    typeof event.output === "object" &&
    !Array.isArray(event.output)
    ? (event.output as { message?: string; reasoning?: string })
    : {};
}

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

function summarizeLlmOutput(output: unknown): Json {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return null;
  }
  const outputRecord = output as { message?: unknown; reasoning?: unknown };

  return {
    ...(typeof outputRecord.reasoning === "string"
      ? { reasoning: outputRecord.reasoning }
      : {}),
    ...(typeof outputRecord.message === "string"
      ? { message: outputRecord.message }
      : {}),
  } as Json;
}

function summarizeLlmSpan(event: CapturedLogEvent | undefined): Json {
  const summary = summarizeSpan(event) as Record<string, Json>;
  summary.output = summarizeLlmOutput(event?.output);
  return summary as Json;
}

function summarize(events: CapturedLogEvent[]): Json {
  const runTask = findCodexTask(events, "openai-codex-run-operation");
  const streamedTask = findCodexTask(
    events,
    "openai-codex-run-streamed-operation",
  );
  const llmSpans = latestSpansByType(events, "llm");
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
    llms: llmSpans.map(summarizeLlmSpan),
    tools: toolSpans.map(summarizeSpan),
  } as Json);
}

function mockSnapshotPath(options: {
  snapshotName?: string;
  testFileUrl?: string;
}): string {
  if (!options.snapshotName || !options.testFileUrl) {
    throw new Error(
      "Mock OpenAI Codex instrumentation assertions require snapshotName and testFileUrl",
    );
  }
  return resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-events.json`,
  );
}

export function defineOpenAICodexInstrumentationAssertions(options: {
  mode: CodexScenarioMode;
  name: string;
  runScenario: RunOpenAICodexScenario;
  snapshotName?: string;
  testFileUrl?: string;
  timeoutMs: number;
}): void {
  const testConfig = {
    ...(options.mode === "mock" ? { tags: [E2E_TAGS.hermetic] } : {}),
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
      for (const operationName of OPERATION_NAMES) {
        const operation = findLatestSpan(events, operationName);
        const task = findCodexTask(events, operationName);

        expect(operation).toBeDefined();
        expect(task).toBeDefined();
        expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
        expect(task?.row.metadata).toMatchObject({
          provider: "openai",
        });
        expect(task?.row.metadata?.["openai_codex.model"]).toEqual(
          expect.any(String),
        );
      }
    });

    test("captures dynamic LLM spans for each Codex turn", testConfig, () => {
      const llmSpans = latestSpansByType(events, "llm");

      expect(llmSpans.length).toBeGreaterThanOrEqual(OPERATION_NAMES.length);
      expect(
        llmSpans.every((event) => event.span.name === "OpenAI Codex LLM"),
      ).toBe(true);

      for (const operationName of OPERATION_NAMES) {
        const task = findCodexTask(events, operationName);
        const childSpans = latestSpansForParent(events, task?.span.id);
        const taskLlmSpans = childSpans.filter(
          (event) => event.span.type === "llm",
        );
        const sequences = taskLlmSpans
          .map(sequenceNumber)
          .filter((value): value is number => value !== undefined);

        expect(taskLlmSpans.length).toBeGreaterThanOrEqual(1);
        expect(sequences[0]).toBe(1);
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        expect(taskLlmSpans.some((event) => outputText(event).length > 2)).toBe(
          true,
        );
      }
    });

    test(
      "captures Codex tool spans when the agent uses tools",
      testConfig,
      () => {
        const toolSpans = latestSpansByType(events, "tool");

        expect(toolSpans.length).toBeGreaterThanOrEqual(OPERATION_NAMES.length);
        expect(
          toolSpans.some(
            (event) => event.span.name === "tool: command_execution",
          ),
        ).toBe(true);

        for (const operationName of OPERATION_NAMES) {
          const task = findCodexTask(events, operationName);
          const childSpans = latestSpansForParent(events, task?.span.id);
          const childTypes = childSpans.map((event) => event.span.type);

          expect(childTypes).toContain("llm");
          expect(childTypes).toContain("tool");
        }
      },
    );

    test("captures final responses and usage metrics", testConfig, () => {
      for (const operationName of OPERATION_NAMES) {
        const task = findCodexTask(events, operationName);

        expect(outputText(task)).toContain(EXPECTED_MARKERS[operationName]);
        expectPositiveMetric(task, [
          "tokens",
          "prompt_tokens",
          "completion_tokens",
        ]);
      }
    });

    if (options.mode === "mock") {
      test(
        "captures deterministic mock LLM and tool details",
        testConfig,
        () => {
          const llmSpans = latestSpansByType(events, "llm");
          const toolSpans = latestSpansByType(events, "tool");

          expect(llmSpans).toHaveLength(8);
          expect(
            llmSpans.some((event) => {
              const output = llmOutput(event);
              return (
                output.reasoning === "final reasoning OPENAI_CODEX_RUN_OK" &&
                output.message === "Codex OPENAI_CODEX_RUN_OK"
              );
            }),
          ).toBe(true);
          expect(
            llmSpans.some(
              (event) =>
                llmOutput(event).reasoning ===
                "reasoning after command OPENAI_CODEX_STREAM_OK",
            ),
          ).toBe(true);

          for (const operationName of OPERATION_NAMES) {
            const task = findCodexTask(events, operationName);
            expect(
              latestSpansForParent(events, task?.span.id).map(childSpanLabel),
            ).toEqual([
              "llm",
              "tool: command_execution",
              "llm",
              "tool: read_file",
              "llm",
              "tool: web_search",
              "llm",
            ]);
          }

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
        },
      );

      test("captures deterministic mock usage metrics", testConfig, () => {
        const runTask = findCodexTask(events, "openai-codex-run-operation");

        expect(runTask?.metrics).toMatchObject({
          completion_tokens: 7,
          prompt_cached_tokens: 3,
          prompt_tokens: 11,
        });
      });

      test("matches the mock span snapshot", testConfig, async () => {
        await expect(
          formatJsonFileSnapshot(summarize(events)),
        ).toMatchFileSnapshot(mockSnapshotPath(options));
      });
    }
  });
}
