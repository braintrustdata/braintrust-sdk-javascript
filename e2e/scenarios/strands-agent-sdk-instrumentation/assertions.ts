import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import type { Json } from "../../helpers/normalize";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
} from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { MODEL_NAME, ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunStrandsAgentSDKScenario = (harness: {
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

const SNAPSHOT_METADATA_KEYS = [
  "gen_ai.tool.name",
  "model",
  "operation",
  "provider",
  "scenario",
  "strands.agent.id",
  "strands.agent.name",
  "strands.handoffs",
  "strands.model.api",
  "strands.node.id",
  "strands.node.status",
  "strands.node.type",
  "strands.operation",
  "strands.orchestrator.id",
  "strands.status",
  "strands.stop_reason",
  "strands.tool.name",
] as const;

const OPERATION_NAMES = [
  "strands-agent-invoke-operation",
  "strands-agent-stream-operation",
  "strands-graph-invoke-operation",
  "strands-swarm-invoke-operation",
];

function pickSnapshotMetadata(
  value: unknown,
): Record<string, Json> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const metadata = Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      SNAPSHOT_METADATA_KEYS.includes(
        key as (typeof SNAPSHOT_METADATA_KEYS)[number],
      ),
    ),
  ) as Record<string, Json>;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeValue(value: unknown): Json | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.replace(/call_[A-Za-z0-9_-]+/g, "<tool-call-id>");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry) ?? null) as Json;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeValue(entry) ?? null,
      ]),
    ) as Json;
  }
  return value as Json;
}

function normalizeSnapshotMetrics(
  value: unknown,
): Record<string, Json> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const metrics = Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if (key === "start" || key === "end") {
          return [key, "<timestamp>"];
        }
        if (
          key === "duration" ||
          key === "strands.duration_ms" ||
          key === "strands.latency_ms" ||
          key === "strands.node.duration_ms" ||
          key === "strands.time_to_first_byte_ms"
        ) {
          return [key, "<duration>"];
        }
        return [key, normalizeValue(entry) ?? null];
      }),
  ) as Record<string, Json>;

  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function snapshotFields(event: CapturedLogEvent) {
  const fields = spanTreeFields(event);

  return {
    span_attributes: fields.span_attributes,
    input:
      event.span.type === "llm" || event.span.type === undefined
        ? undefined
        : normalizeValue(fields.input),
    output:
      event.span.type === "llm" || event.span.type === undefined
        ? undefined
        : normalizeValue(fields.output),
    metadata: normalizeValue(pickSnapshotMetadata(fields.metadata)),
    metrics: normalizeSnapshotMetrics(fields.metrics),
    error: fields.error,
  };
}

function latestEventsPerSpan(events: CapturedLogEvent[]): CapturedLogEvent[] {
  const orderedSpanIds: string[] = [];
  const latestBySpanId = new Map<string, CapturedLogEvent>();

  for (const event of events) {
    if (!event.span.id) {
      continue;
    }
    if (!latestBySpanId.has(event.span.id)) {
      orderedSpanIds.push(event.span.id);
    }
    latestBySpanId.set(event.span.id, event);
  }

  return orderedSpanIds.flatMap((spanId) => {
    const event = latestBySpanId.get(spanId);
    return event ? [event] : [];
  });
}

function summarize(events: CapturedLogEvent[]): SpanTreeEntry[] {
  const latestEvents = latestEventsPerSpan(events);
  const names = new Set([
    ROOT_NAME,
    ...OPERATION_NAMES,
    "Agent: weather-agent",
    "Agent: stream-agent",
    "Agent: graph-researcher",
    "Agent: graph-writer",
    "Agent: swarm-router",
    "Agent: swarm-finisher",
    `Strands model: ${MODEL_NAME}`,
    "Strands Graph",
    "Strands Swarm",
    "node: graph-researcher",
    "node: graph-writer",
    "node: swarm-router",
    "node: swarm-finisher",
    "tool: lookup_weather",
  ]);

  return latestEvents
    .filter((event) => event.span.name && names.has(event.span.name))
    .map((event) => ({
      event,
      fields: snapshotFields(event),
    }));
}

function findLatestChild(
  events: CapturedLogEvent[],
  name: string,
  parentId: string | undefined,
): CapturedLogEvent | undefined {
  return findChildSpans(events, name, parentId).at(-1);
}

export function defineStrandsAgentSDKInstrumentationAssertions(options: {
  name: string;
  runScenario: RunStrandsAgentSDKScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const spanSnapshotPath = resolveFileSnapshotPath(
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

    test("captures the root trace", testConfig, () => {
      expect(setupError).toBeUndefined();
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
    });

    test("captures agent invoke and stream spans", testConfig, () => {
      expect(setupError).toBeUndefined();
      const invokeOperation = findLatestSpan(
        events,
        "strands-agent-invoke-operation",
      );
      const invokeAgent = findLatestChild(
        events,
        "Agent: weather-agent",
        invokeOperation?.span.id,
      );
      const invokeModels = findChildSpans(
        events,
        `Strands model: ${MODEL_NAME}`,
        invokeAgent?.span.id,
      );
      const toolSpan = findLatestChild(
        events,
        "tool: lookup_weather",
        invokeAgent?.span.id,
      );
      const streamOperation = findLatestSpan(
        events,
        "strands-agent-stream-operation",
      );
      const streamAgent = findLatestChild(
        events,
        "Agent: stream-agent",
        streamOperation?.span.id,
      );
      const streamModels = findChildSpans(
        events,
        `Strands model: ${MODEL_NAME}`,
        streamAgent?.span.id,
      );

      expect(invokeAgent?.span.type).toBe("task");
      expect(invokeAgent?.row.metadata).toMatchObject({
        "strands.operation": "Agent.stream",
        provider: "openai",
      });
      expect(JSON.stringify(invokeAgent?.output)).toContain(
        "STRANDS_AGENT_TOOL_OK",
      );

      expect(invokeModels.length).toBeGreaterThanOrEqual(1);
      expect(invokeModels[0]?.span.type).toBe("llm");
      expect(invokeModels[0]?.row.metadata).toMatchObject({
        model: MODEL_NAME,
        provider: "openai",
        "strands.operation": "model.stream",
      });

      expect(toolSpan?.span.type).toBe("tool");
      expect(toolSpan?.input).toMatchObject({ city: "Vienna" });
      expect(toolSpan?.row.metadata).toMatchObject({
        "gen_ai.tool.name": "lookup_weather",
        "strands.tool.name": "lookup_weather",
      });
      expect(toolSpan?.row.metadata?.["gen_ai.tool.call.id"]).toEqual(
        expect.any(String),
      );
      expect(JSON.stringify(toolSpan?.output)).toContain("STRANDS_TOOL_OK");

      expect(streamAgent?.span.type).toBe("task");
      expect(JSON.stringify(streamAgent?.output)).toContain(
        "STRANDS_AGENT_STREAM_OK",
      );
      expect(streamModels.length).toBeGreaterThanOrEqual(1);
    });

    test("captures graph and swarm orchestration spans", testConfig, () => {
      expect(setupError).toBeUndefined();
      const graphOperation = findLatestSpan(
        events,
        "strands-graph-invoke-operation",
      );
      const graph = findLatestChild(
        events,
        "Strands Graph",
        graphOperation?.span.id,
      );
      const graphResearcherNode = findLatestChild(
        events,
        "node: graph-researcher",
        graph?.span.id,
      );
      const graphWriterNode = findLatestChild(
        events,
        "node: graph-writer",
        graph?.span.id,
      );
      const graphWriterAgent = findLatestChild(
        events,
        "Agent: graph-writer",
        graphWriterNode?.span.id,
      );
      const swarmOperation = findLatestSpan(
        events,
        "strands-swarm-invoke-operation",
      );
      const swarm = findLatestChild(
        events,
        "Strands Swarm",
        swarmOperation?.span.id,
      );
      const swarmRouterNode = findLatestChild(
        events,
        "node: swarm-router",
        swarm?.span.id,
      );
      const swarmFinisherNode = findLatestChild(
        events,
        "node: swarm-finisher",
        swarm?.span.id,
      );
      const swarmFinisherAgent = findLatestChild(
        events,
        "Agent: swarm-finisher",
        swarmFinisherNode?.span.id,
      );

      expect(graph?.span.type).toBe("task");
      expect(graph?.row.metadata).toMatchObject({
        "strands.operation": "Graph.stream",
        "strands.orchestrator.id": "weather-graph",
        provider: "strands",
      });
      expect(JSON.stringify(graph?.output)).toContain("STRANDS_GRAPH_OK");
      expect(graphResearcherNode?.row.metadata).toMatchObject({
        "strands.node.id": "graph-researcher",
        "strands.node.status": "COMPLETED",
      });
      expect(graphWriterNode?.row.metadata).toMatchObject({
        "strands.node.id": "graph-writer",
        "strands.node.status": "COMPLETED",
      });
      expect(graphWriterAgent?.span.parentIds).toContain(
        graphWriterNode?.span.id,
      );
      expect(JSON.stringify(graphWriterAgent?.output)).toContain(
        "STRANDS_GRAPH_OK",
      );

      expect(swarm?.span.type).toBe("task");
      expect(swarm?.row.metadata).toMatchObject({
        "strands.handoffs": [
          { source: "swarm-router", targets: ["swarm-finisher"] },
        ],
        "strands.operation": "Swarm.stream",
        "strands.orchestrator.id": "weather-swarm",
      });
      expect(JSON.stringify(swarm?.output)).toContain("STRANDS_SWARM_OK");
      expect(swarmRouterNode?.row.metadata).toMatchObject({
        "strands.node.id": "swarm-router",
        "strands.node.status": "COMPLETED",
      });
      expect(swarmFinisherNode?.row.metadata).toMatchObject({
        "strands.node.id": "swarm-finisher",
        "strands.node.status": "COMPLETED",
      });
      expect(swarmFinisherAgent?.span.parentIds).toContain(
        swarmFinisherNode?.span.id,
      );
      expect(JSON.stringify(swarmFinisherAgent?.output)).toContain(
        "STRANDS_SWARM_OK",
      );
    });

    test(
      "does not emit duplicate OpenAI provider auto spans",
      testConfig,
      () => {
        expect(setupError).toBeUndefined();
        const duplicateProviderSpans = latestEventsPerSpan(events).filter(
          (event) =>
            event.span.name === "Chat Completion" ||
            event.span.name?.startsWith("openai."),
        );

        expect(duplicateProviderSpans).toHaveLength(0);
      },
    );

    test("matches the span tree snapshot", testConfig, async () => {
      expect(setupError).toBeUndefined();
      await matchSpanTreeSnapshot(summarize(events), spanSnapshotPath);
    });
  });
}
