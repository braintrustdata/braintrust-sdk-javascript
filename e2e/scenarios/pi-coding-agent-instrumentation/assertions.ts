import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
  type SpanTreeFields,
} from "../../helpers/span-tree";
import { ROOT_NAME, TOOL_CHILD_SPAN_NAME } from "./scenario.impl.mjs";

type RunPiCodingAgentScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const METADATA_KEYS = [
  "provider",
  "model",
  "operation",
  "scenario",
  "tools",
  "gen_ai.tool.call.id",
  "gen_ai.tool.name",
  "pi_coding_agent.api",
  "pi_coding_agent.model",
  "pi_coding_agent.operation",
  "pi_coding_agent.source",
  "pi_coding_agent.stop_reason",
  "pi_coding_agent.tool.name",
] as const;

function normalizeToolCallIds(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("toolu_")) {
    return "<tool-call-id>";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeToolCallIds(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeToolCallIds(entry),
      ]),
    );
  }

  return value;
}

function snapshotFields(event: CapturedLogEvent): SpanTreeFields {
  const fields = spanTreeFields(event);
  const metadata =
    fields.metadata &&
    typeof fields.metadata === "object" &&
    !Array.isArray(fields.metadata)
      ? Object.fromEntries(
          Object.entries(fields.metadata).filter(([key]) =>
            METADATA_KEYS.includes(key as (typeof METADATA_KEYS)[number]),
          ),
        )
      : undefined;

  return {
    ...fields,
    input: normalizeToolCallIds(fields.input),
    output: normalizeToolCallIds(fields.output),
    metadata: normalizeToolCallIds(metadata),
  };
}

function findPiTask(events: CapturedLogEvent[]) {
  const operation = findLatestSpan(events, "pi-coding-agent-prompt-operation");
  return findChildSpans(events, "AgentSession.prompt", operation?.span.id).at(
    -1,
  );
}

function summarize(
  events: CapturedLogEvent[],
  llmSpanName: string,
): SpanTreeEntry[] {
  const operation = findLatestSpan(events, "pi-coding-agent-prompt-operation");
  const task = findPiTask(events);
  const llm = findChildSpans(events, llmSpanName, task?.span.id).at(-1);
  const tool = findChildSpans(events, "bash", task?.span.id).at(-1);
  const toolChild = findChildSpans(
    events,
    TOOL_CHILD_SPAN_NAME,
    tool?.span.id,
  ).at(-1);

  return [
    findLatestSpan(events, ROOT_NAME),
    operation,
    task,
    llm,
    tool,
    toolChild,
  ].flatMap((event) =>
    event
      ? [
          {
            event,
            fields: snapshotFields(event),
          },
        ]
      : [],
  );
}

export function definePiCodingAgentInstrumentationAssertions(options: {
  name: string;
  provider?: "anthropic" | "openai";
  runScenario: RunPiCodingAgentScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const provider = options.provider ?? "anthropic";
  const llmSpanName =
    provider === "openai"
      ? "openai.responses.create"
      : "anthropic.messages.create";
  const api = provider === "openai" ? "openai-responses" : "anthropic-messages";
  const modelId = provider === "openai" ? "gpt-5-nano" : "claude-haiku-4-5";
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

    test(
      "captures prompt task with nested LLM and tool spans",
      testConfig,
      () => {
        expect(setupError).toBeUndefined();
        const operation = findLatestSpan(
          events,
          "pi-coding-agent-prompt-operation",
        );
        const task = findPiTask(events);
        const llmSpans = findChildSpans(events, llmSpanName, task?.span.id);
        const llm = llmSpans.at(-1);
        const tool = findChildSpans(events, "bash", task?.span.id).at(-1);
        const toolChild = findChildSpans(
          events,
          TOOL_CHILD_SPAN_NAME,
          tool?.span.id,
        ).at(-1);

        expect(operation).toBeDefined();
        expect(task).toBeDefined();
        expect(task?.span.parentIds).toEqual([operation?.span.id ?? ""]);
        expect(task?.span.type).toBe("task");
        expect(task?.row.metadata).toMatchObject({
          "pi_coding_agent.operation": "AgentSession.prompt",
          provider,
        });
        for (const metric of [
          "prompt_tokens",
          "completion_tokens",
          "tokens",
          "prompt_cached_tokens",
          "prompt_cache_creation_tokens",
          "estimated_cost",
        ]) {
          expect(task?.metrics).not.toHaveProperty(metric);
        }
        expect(task?.metrics).toMatchObject({ duration: expect.any(Number) });

        expect(llm).toBeDefined();
        expect(llmSpans).toHaveLength(2);
        expect(llm?.span.type).toBe("llm");
        expect(llm?.row.metadata).toMatchObject({
          "pi_coding_agent.api": api,
          provider,
        });
        expect(String(llm?.row.metadata?.model)).toContain(modelId);
        for (const llmSpan of llmSpans) {
          expect(llmSpan.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "system",
                content: expect.stringContaining("coding assistant"),
              }),
            ]),
          );
          expect(llmSpan.row.metadata?.tools).toEqual([
            {
              type: "function",
              function: expect.objectContaining({
                name: "bash",
                description: expect.any(String),
                parameters: expect.any(Object),
              }),
            },
          ]);
        }
        expect(llm?.output).toBeDefined();
        for (const llmSpan of llmSpans) {
          expect(llmSpan.metrics).toMatchObject({
            completion_tokens: expect.any(Number),
            prompt_tokens: expect.any(Number),
            tokens: expect.any(Number),
          });
        }

        expect(tool).toBeDefined();
        expect(tool?.span.type).toBe("tool");
        expect(tool?.input).toMatchObject({
          command: expect.stringContaining("printf pi_tool_ok"),
        });
        expect(tool?.row.metadata).toMatchObject({
          "gen_ai.tool.name": "bash",
        });
        expect(tool?.row.metadata?.["gen_ai.tool.call.id"]).toEqual(
          expect.any(String),
        );
        expect(JSON.stringify(tool?.output)).toContain("pi_tool_ok");

        expect(toolChild).toBeDefined();
        expect(toolChild?.span.parentIds).toEqual([tool?.span.id ?? ""]);
      },
    );

    test("matches the shared span tree snapshot", testConfig, async () => {
      expect(setupError).toBeUndefined();
      await matchSpanTreeSnapshot(summarize(events, llmSpanName), snapshotPath);
    });
  });
}
