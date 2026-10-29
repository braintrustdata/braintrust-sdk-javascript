import { describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type runNodeScenarioDir,
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
  runNodeScenarioDir: typeof runNodeScenarioDir;
}) => Promise<void>;

function normalizePiSnapshotValue(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("toolu_")) {
    return "<tool-call-id>";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizePiSnapshotValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "pi_coding_agent.session_id"
          ? "<session-id>"
          : key === "wall_time_seconds" && typeof entry === "number"
            ? "<duration>"
            : normalizePiSnapshotValue(entry),
      ]),
    );
  }

  return value;
}

function snapshotFields(event: CapturedLogEvent): SpanTreeFields {
  const fields = spanTreeFields(event);
  return {
    ...fields,
    input: normalizePiSnapshotValue(fields.input),
    output: normalizePiSnapshotValue(fields.output),
    metadata: normalizePiSnapshotValue(fields.metadata),
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
  const llmSpans = findChildSpans(events, llmSpanName, task?.span.id);
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
    ...llmSpans,
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
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  describe(options.name, () => {
    test(
      "captures the prompt, LLM, and tool span tree",
      { timeout: effectiveScenarioTimeoutMs(options.timeoutMs) },
      async () => {
        let events: CapturedLogEvent[] = [];
        await withScenarioHarness(async (harness) => {
          await options.runScenario(harness);
          events = harness.events();
        });
        const operation = findLatestSpan(
          events,
          "pi-coding-agent-prompt-operation",
        );
        expect(
          findChildSpans(events, "AgentSession.prompt", operation?.span.id),
        ).toHaveLength(1);
        const task = findPiTask(events);
        const llms = findChildSpans(events, llmSpanName, task?.span.id);
        const tools = findChildSpans(events, "bash", task?.span.id);
        expect(llms).toHaveLength(2);
        expect(tools).toHaveLength(1);
        expect(
          findChildSpans(events, TOOL_CHILD_SPAN_NAME, tools[0]?.span.id),
        ).toHaveLength(1);
        for (const span of [task, ...llms, ...tools]) {
          expect(span?.metrics).toMatchObject({
            start: expect.any(Number),
            end: expect.any(Number),
          });
        }
        // Snapshots assert the full payloads and hierarchy; counts above also
        // catch duplicate spans that summarize() would otherwise select past.
        await matchSpanTreeSnapshot(
          summarize(events, llmSpanName),
          snapshotPath,
        );
      },
    );
  });
}
