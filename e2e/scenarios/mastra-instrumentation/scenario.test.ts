import { beforeAll, describe, expect, test } from "vitest";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findLatestSpan } from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const mastraScenarios = await Promise.all(
  [
    {
      dependencyName: "mastra-core-v1",
      snapshotName: "mastra-v1",
    },
    {
      dependencyName: "mastra-core-v1-latest",
      snapshotName: "mastra-v1-latest",
    },
  ].map(async (scenario) => ({
    ...scenario,
    version: await readInstalledPackageVersion(
      scenarioDir,
      scenario.dependencyName,
    ),
  })),
);
const TIMEOUT_MS = 90_000;
const ROOT_NAME = "mastra-instrumentation-root";
const SCENARIO_NAME = "mastra-instrumentation";

// Metadata keys that Mastra's ObservabilityExporter surfaces and that we
// want anchored in the snapshot. We intentionally keep this allowlist tight
// so future Mastra additions don't churn the snapshot.
const SNAPSHOT_METADATA_KEYS = [
  "agent_id",
  "agent_name",
  "entity_id",
  "entity_name",
  "entity_type",
  "method",
  "model",
  "operation",
  "provider",
  "scenario",
  "step_id",
  "tool_id",
  "workflow_id",
];

function relevantMastraEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  return events.filter(
    (event) =>
      event.span.name === ROOT_NAME ||
      event.span.name?.startsWith("mastra-") ||
      event.row.metadata?.entity_type !== undefined ||
      event.span.type === "llm" ||
      event.span.type === "tool",
  );
}

// Mastra injects a per-message `providerOptions.mastra.createdAt` timestamp
// that's a real wall-clock value, not from a cassette — strip it so the
// snapshot doesn't drift run-to-run. Recursive because messages can be
// arbitrarily nested arrays/objects.
function scrubMastraProviderTimestamps(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(scrubMastraProviderTimestamps);
  }
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "providerOptions" &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child) &&
        "mastra" in child &&
        child.mastra &&
        typeof child.mastra === "object"
      ) {
        out[key] = {
          ...child,
          mastra: { ...child.mastra, createdAt: 0 },
        } as Json;
      } else {
        out[key] = scrubMastraProviderTimestamps(child as Json);
      }
    }
    return out;
  }
  return value;
}

function summarizeMetrics(
  metrics: CapturedLogEvent["metrics"],
): Record<string, Json> | undefined {
  if (!metrics) return undefined;

  const entries = Object.entries(metrics)
    .filter(
      ([key, value]) => key !== "start" && key !== "end" && value !== undefined,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value as Json] as const);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function summarizeMastraPayload(event: CapturedLogEvent): Record<string, Json> {
  const metadata = event.row.metadata as Record<string, unknown> | undefined;
  const pickedMetadata = Object.fromEntries(
    SNAPSHOT_METADATA_KEYS.flatMap((key) =>
      metadata && key in metadata ? [[key, metadata[key] as Json]] : [],
    ),
  );

  // Show real input/output content for spans that produce LLM/tool data so
  // we can verify the exporter is forwarding Mastra's payloads (reviewer
  // asked to loosen the boolean-only summary). The normalize helpers below
  // strip timestamps and UUIDs so the snapshot stays deterministic.
  const result: Record<string, Json> = {
    metadata:
      Object.keys(pickedMetadata).length > 0 ? (pickedMetadata as Json) : null,
    name: event.span.name ?? null,
    type: event.span.type ?? null,
  };

  const metrics = summarizeMetrics(event.metrics);
  if (metrics) {
    result.metrics = metrics;
  }

  if (event.input !== undefined && event.input !== null) {
    result.input = scrubMastraProviderTimestamps(event.input as Json);
  }
  if (event.output !== undefined && event.output !== null) {
    result.output = scrubMastraProviderTimestamps(event.output as Json);
  }
  return result;
}

for (const scenario of mastraScenarios) {
  describe(`mastra sdk ${scenario.version} auto-hook instrumentation`, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir({
          entry: "scenario.mjs",
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          env: { MASTRA_CORE_PACKAGE_NAME: scenario.dependencyName },
          runContext: {
            variantKey: scenario.snapshotName,
            originalScenarioDir,
          },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
        events = harness.events();
      });
    }, TIMEOUT_MS);

    test("captures the root trace for the scenario", () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({
        scenario: SCENARIO_NAME,
      });
    });

    // Anchored on entity_type strings emitted by Mastra's ObservabilityExporter
    // (lowercased, matching the SpanType enum's serialized form) rather than
    // version-specific span name conventions.
    test("captures agent run spans for the registered agent", () => {
      const agentSpans = events.filter(
        (event) =>
          event.row.metadata?.entity_type === "agent" &&
          event.span.type === "task" &&
          (event.row.metadata?.entity_id === "weather-agent" ||
            event.row.metadata?.entity_name === "Weather Agent"),
      );
      expect(agentSpans.length).toBeGreaterThanOrEqual(2);
    });

    test("captures workflow run and step spans", () => {
      const workflowRunSpans = events.filter(
        (event) =>
          event.row.metadata?.entity_type === "workflow_run" &&
          event.span.type === "task",
      );
      expect(workflowRunSpans.length).toBeGreaterThanOrEqual(1);

      const workflowStepSpans = events.filter(
        (event) =>
          event.row.metadata?.entity_type === "workflow_step" &&
          event.span.type === "function",
      );
      expect(workflowStepSpans.length).toBeGreaterThanOrEqual(1);
    });

    test("captures model generation spans with token usage metrics", () => {
      const modelSpans = events.filter(
        (event) =>
          event.span.type === "llm" &&
          Object.keys(event.metrics ?? {}).some((key) =>
            ["prompt_tokens", "completion_tokens", "tokens"].includes(key),
          ),
      );
      expect(modelSpans.length).toBeGreaterThanOrEqual(1);
    });

    test("matches the shared span tree snapshot", async () => {
      await matchSpanTreeSnapshot(
        relevantMastraEvents(events).map((event) => {
          const fields = summarizeMastraPayload(event);
          delete fields.name;
          delete fields.type;
          return {
            event,
            fields,
            name: normalizeForSnapshot(
              event.span.name ?? "<unnamed>",
            ) as string,
          };
        }),
        resolveFileSnapshotPath(
          import.meta.url,
          `${scenario.snapshotName}.span-tree.json`,
        ),
      );
    });

    test("matches the shared payload snapshot", async () => {
      const payloadSummary = normalizeForSnapshot(
        relevantMastraEvents(events).map((event) =>
          summarizeMastraPayload(event),
        ) as Json,
      );

      await expect(formatJsonFileSnapshot(payloadSummary)).toMatchFileSnapshot(
        resolveFileSnapshotPath(
          import.meta.url,
          `${scenario.snapshotName}.log-payloads.json`,
        ),
      );
    });
  });
}
