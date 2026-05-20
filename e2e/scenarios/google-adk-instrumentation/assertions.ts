import { beforeAll, describe, expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  matchFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";

import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunGoogleADKScenario = (harness: {
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

const VOLATILE_ADK_METRIC_KEYS = new Set([
  "completion_reasoning_tokens",
  "completion_tokens",
  "prompt_cached_tokens",
  "prompt_tokens",
  "tokens",
]);
function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeADKVariableTokenCounts(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeADKVariableTokenCounts(entry as Json));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized = structuredClone(value);

  for (const [key, entry] of Object.entries(normalized)) {
    if (
      typeof entry === "number" &&
      [
        "candidatesTokenCount",
        "completion_tokens",
        "prompt_tokens",
        "tokens",
        "totalTokenCount",
        "completion_reasoning_tokens",
        "thoughtsTokenCount",
      ].includes(key)
    ) {
      normalized[key] = "<number>";
      continue;
    }

    normalized[key] = normalizeADKVariableTokenCounts(entry as Json);
  }

  return normalized;
}

function normalizeADKMetrics(metrics: Json): Json {
  if (!isRecord(metrics)) {
    return metrics;
  }

  const normalized = structuredClone(metrics);
  for (const key of VOLATILE_ADK_METRIC_KEYS) {
    delete normalized[key];
  }
  return normalizeADKVariableTokenCounts(normalized);
}

function normalizeADKSummary(summary: Json): Json {
  if (!isRecord(summary) || !Array.isArray(summary.metric_keys)) {
    return summary;
  }

  return {
    ...summary,
    metric_keys: summary.metric_keys.filter(
      (metric): metric is string =>
        typeof metric === "string" && !VOLATILE_ADK_METRIC_KEYS.has(metric),
    ),
  } satisfies Json;
}

function normalizeADKOutput(value: Json): Json {
  const normalized = normalizeADKVariableTokenCounts(value);

  if (!isRecord(normalized)) {
    return normalized;
  }

  const cloned = structuredClone(normalized);

  if (typeof cloned.content === "string") {
    cloned.content = "<text>";
  }
  if (typeof cloned.thought === "string") {
    cloned.thought = "<text>";
  }

  return cloned;
}

function dedupeSnapshotItems(items: Json[]): Json[] {
  const deduped: Json[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function sortBySpanDepth(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const lastById = new Map<string, CapturedLogEvent>();
  for (const event of events) {
    if (event.span.id) {
      lastById.set(event.span.id, event);
    }
  }

  const depthCache = new Map<string, number>();
  function getDepth(spanId: string | undefined): number {
    if (!spanId) return 0;
    if (depthCache.has(spanId)) return depthCache.get(spanId)!;
    const event = lastById.get(spanId);
    if (!event || event.span.parentIds.length === 0) {
      depthCache.set(spanId, 0);
      return 0;
    }
    const depth = 1 + getDepth(event.span.parentIds[0]);
    depthCache.set(spanId, depth);
    return depth;
  }

  return [...events].sort((a, b) => getDepth(a.span.id) - getDepth(b.span.id));
}

function hasOptionalADKTaskOutput(event: CapturedLogEvent): boolean {
  return (
    event.span.type === "task" &&
    (event.span.name === "Google ADK Runner" ||
      event.span.name?.startsWith("Agent:"))
  );
}

function summarizeADKSpan(event: CapturedLogEvent): Json {
  const summary = summarizeWrapperContract(event, [
    "model",
    "operation",
    "scenario",
    "provider",
    "google_adk.agent_name",
    "google_adk.user_id",
    "google_adk.session_id",
    "google_adk.tool_name",
    "google_adk.tool_call_id",
  ]) as Record<string, Json>;

  if (hasOptionalADKTaskOutput(event)) {
    delete summary.has_output;
  }

  return normalizeADKSummary(summary);
}

function summarizeADKPayload(event: CapturedLogEvent): Json {
  const metadata = event.row.metadata as Record<string, unknown> | undefined;
  const pickedMetadata: Record<string, Json> = {};

  if (metadata) {
    for (const key of [
      "model",
      "operation",
      "scenario",
      "provider",
      "google_adk.agent_name",
      "google_adk.user_id",
      "google_adk.session_id",
      "google_adk.tool_name",
      "google_adk.tool_call_id",
    ]) {
      if (key in metadata) {
        pickedMetadata[key] = metadata[key] as Json;
      }
    }
  }

  const summary: Record<string, Json> = {
    input: event.input as Json,
    metadata:
      Object.keys(pickedMetadata).length > 0 ? (pickedMetadata as Json) : null,
    metrics: normalizeADKMetrics(event.metrics as Json),
    name: event.span.name ?? null,
    output: normalizeADKOutput(event.output as Json),
    type: event.span.type ?? null,
  };

  if (hasOptionalADKTaskOutput(event)) {
    delete summary.output;
  }

  return summary satisfies Json;
}

export function defineGoogleADKInstrumentationAssertions(options: {
  expectLLMSpan: boolean;
  name: string;
  runScenario: RunGoogleADKScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-events.json`,
  );
  const payloadSnapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.log-payloads.json`,
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

    test("captures runner span for Runner.runAsync()", testConfig, () => {
      const runnerSpan = findLatestSpan(events, "Google ADK Runner");

      expect(runnerSpan).toBeDefined();
      expect(runnerSpan?.span.type).toBe("task");
      expect(runnerSpan?.row.metadata).toMatchObject({
        provider: "google-adk",
      });
    });

    test("captures agent span for Agent.runAsync()", testConfig, () => {
      const agentSpan = events.find(
        (e) => e.span.name?.startsWith("Agent:") && e.span.type === "task",
      );

      expect(agentSpan).toBeDefined();
    });

    test("captures nested SequentialAgent sub-agent names", testConfig, () => {
      const agentSpans = events.filter(
        (e) => e.span.name?.startsWith("Agent:") && e.span.type === "task",
      );
      const agentSpanNames = agentSpans.map((e) => e.span.name);

      expect(agentSpanNames).toEqual(
        expect.arrayContaining([
          "Agent: sequential_workflow",
          "Agent: greeter",
          "Agent: farewell",
        ]),
      );

      const workflowSpan = agentSpans.find(
        (e) => e.span.name === "Agent: sequential_workflow",
      );
      const greeterSpan = agentSpans.find(
        (e) => e.span.name === "Agent: greeter",
      );
      const farewellSpan = agentSpans.find(
        (e) => e.span.name === "Agent: farewell",
      );

      expect(greeterSpan?.span.parentIds).toContain(workflowSpan?.span.id);
      expect(farewellSpan?.span.parentIds).toContain(workflowSpan?.span.id);
    });

    test("captures tool span for Tool.runAsync()", testConfig, () => {
      const toolSpan = [...events]
        .reverse()
        .find(
          (e) =>
            e.span.name?.startsWith("tool:") &&
            e.span.type === "tool" &&
            e.output !== undefined,
        );

      expect(toolSpan).toBeDefined();
      expect(toolSpan?.output).toBeDefined();
      expect(toolSpan?.row.metadata).toMatchObject({
        provider: "google-adk",
      });
    });

    test("nests the agent span under the runner span", testConfig, () => {
      const runnerSpan = events.find(
        (e) =>
          e.span.name === "Google ADK Runner" &&
          e.row.metadata?.["google_adk.session_id"] === "test-session-1",
      );
      const agentSpan = events.find(
        (e) => e.span.name === "Agent: weather_agent" && e.span.type === "task",
      );

      expect(runnerSpan).toBeDefined();
      expect(agentSpan).toBeDefined();
      expect(agentSpan?.span.parentIds).toContain(runnerSpan?.span.id);
      expect(agentSpan?.span.rootId).toBe(runnerSpan?.span.rootId);
    });

    test("captures LLM spans from underlying @google/genai", testConfig, () => {
      const llmSpan = events.find((e) => e.span.type === "llm");

      if (!options.expectLLMSpan) {
        expect(llmSpan).toBeUndefined();
        return;
      }

      expect(llmSpan).toBeDefined();
      expect(llmSpan?.metrics).toBeDefined();
    });

    test("matches the shared span snapshot", testConfig, async () => {
      const relevantEvents = sortBySpanDepth(
        events.filter(
          (e) =>
            e.span.name !== undefined && e.span.type !== "llm" && e.span.ended,
        ),
      );
      const spanSummary = normalizeForSnapshot(
        dedupeSnapshotItems(
          relevantEvents.map((event) => summarizeADKSpan(event)) as Json[],
        ) as Json,
      );

      await matchFileSnapshot(
        formatJsonFileSnapshot(spanSummary),
        spanSnapshotPath,
      );
    });

    test("matches the shared payload snapshot", testConfig, async () => {
      const relevantEvents = sortBySpanDepth(
        events.filter(
          (e) =>
            e.span.name !== undefined && e.span.type !== "llm" && e.span.ended,
        ),
      );
      const payloadSummary = normalizeForSnapshot(
        dedupeSnapshotItems(
          relevantEvents.map((event) => summarizeADKPayload(event)) as Json[],
        ) as Json,
      );

      await matchFileSnapshot(
        formatJsonFileSnapshot(payloadSummary),
        payloadSnapshotPath,
      );
    });
  });
}
