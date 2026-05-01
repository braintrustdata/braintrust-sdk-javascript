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
import { findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";

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

const SNAPSHOT_METADATA_KEYS = [
  "agent_id",
  "agent_name",
  "method",
  "operation",
  "scenario",
  "tool_id",
  "workflow_id",
  "workflow_run_id",
];

function relevantMastraEvents(events: CapturedLogEvent[]): CapturedLogEvent[] {
  return events.filter(
    (event) =>
      event.span.name === ROOT_NAME ||
      event.span.name?.startsWith("mastra-") ||
      event.span.name?.startsWith("Mastra ") ||
      event.span.type === "llm",
  );
}

function summarizeMastraPayload(event: CapturedLogEvent): Json {
  const metadata = event.row.metadata as Record<string, unknown> | undefined;
  const pickedMetadata = Object.fromEntries(
    SNAPSHOT_METADATA_KEYS.flatMap((key) =>
      metadata && key in metadata ? [[key, metadata[key] as Json]] : [],
    ),
  );

  return {
    has_input: event.input !== undefined && event.input !== null,
    has_output: event.output !== undefined && event.output !== null,
    metadata:
      Object.keys(pickedMetadata).length > 0 ? (pickedMetadata as Json) : null,
    metric_keys: Object.keys(event.metrics ?? {})
      .filter((key) => key !== "start" && key !== "end")
      .sort(),
    name: event.span.name ?? null,
    type: event.span.type ?? null,
  } satisfies Json;
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

  test("captures agent generate and stream spans", () => {
    expect(
      findLatestSpan(events, "Mastra Agent Weather Agent generate"),
    ).toBeDefined();
    expect(
      findLatestSpan(events, "Mastra Agent Weather Agent stream"),
    ).toBeDefined();
  });

  test("captures direct and workflow-nested tool spans", () => {
    const toolSpans = events.filter(
      (event) =>
        event.span.name === "Mastra Tool lookup_weather" &&
        event.output !== undefined,
    );

    expect(toolSpans.length).toBeGreaterThanOrEqual(2);
    expect(
      toolSpans.some(
        (event) =>
          event.row.metadata?.workflow_id === "travel-flow" &&
          event.row.metadata?.workflow_run_id === "workflow-run-context",
      ),
    ).toBe(true);
  });

  test("captures workflow run and step spans", () => {
    expect(
      findLatestSpan(events, "Mastra Workflow travel-flow start"),
    ).toBeDefined();
    expect(
      findLatestSpan(
        events,
        "Mastra Workflow Step workflow.travel-flow.step.lookup-step",
      ),
    ).toBeDefined();
  });

  test("nests the workflow tool under the workflow step", () => {
    const stepSpan = findLatestSpan(
      events,
      "Mastra Workflow Step workflow.travel-flow.step.lookup-step",
    );
    const nestedTool = events.find(
      (event) =>
        event.span.name === "Mastra Tool lookup_weather" &&
        event.row.metadata?.workflow_run_id === "workflow-run-context" &&
        event.span.parentIds.includes(stepSpan?.span.id ?? ""),
    );

    expect(stepSpan).toBeDefined();
    expect(nestedTool).toBeDefined();
  });

  test("captures nested Mastra execution workflow spans during agent execution", () => {
    const generateSpan = findLatestSpan(
      events,
      "Mastra Agent Weather Agent generate",
    );
    const nestedExecutionWorkflow = events.find(
      (event) =>
        event.span.name === "Mastra Workflow execution-workflow start" &&
        event.span.parentIds.includes(generateSpan?.span.id ?? ""),
    );

    expect(generateSpan).toBeDefined();
    expect(nestedExecutionWorkflow).toBeDefined();
  });

  test("matches the shared span snapshot", async () => {
    const spanSummary = normalizeForSnapshot(
      relevantMastraEvents(events).map((event) =>
        summarizeWrapperContract(event, SNAPSHOT_METADATA_KEYS),
      ) as Json,
    );

    await expect(formatJsonFileSnapshot(spanSummary)).toMatchFileSnapshot(
      resolveFileSnapshotPath(
        import.meta.url,
        `${snapshotName}.span-events.json`,
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
