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

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});
const mastraVersion = await readInstalledPackageVersion(
  scenarioDir,
  "@mastra/core",
);
const snapshotName = resolveSnapshotName(mastraVersion);
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
    metric_keys: Object.keys(event.metrics ?? {})
      .filter((key) => key !== "start" && key !== "end")
      .sort(),
    name: event.span.name ?? null,
    type: event.span.type ?? null,
  };

  if (event.input !== undefined && event.input !== null) {
    result.input = scrubMastraProviderTimestamps(event.input as Json);
  }
  if (event.output !== undefined && event.output !== null) {
    result.output = scrubMastraProviderTimestamps(event.output as Json);
  }
  return result;
}

function resolveSnapshotName(version: string): string {
  switch (version) {
    case "1.26.0":
      return "mastra-v1260";
    case "1.26.1-alpha.0":
      return "mastra-v1261-alpha0";
    default:
      throw new Error(
        `Unsupported @mastra/core version for e2e snapshots: ${version}`,
      );
  }
}

describe(`mastra sdk ${mastraVersion} auto-hook instrumentation`, () => {
  let events: CapturedLogEvent[] = [];

  beforeAll(async () => {
    await withScenarioHarness(async (harness) => {
      await harness.runNodeScenarioDir({
        entry: "scenario.mjs",
        nodeArgs: ["--import", "braintrust/hook.mjs"],
        runContext: { variantKey: snapshotName },
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
          name: normalizeForSnapshot(event.span.name ?? "<unnamed>") as string,
        };
      }),
      resolveFileSnapshotPath(
        import.meta.url,
        `${snapshotName}.span-tree.json`,
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
        `${snapshotName}.log-payloads.json`,
      ),
    );
  });
});
