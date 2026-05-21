import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import {
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
  type SpanTreeFields,
} from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

type RunCopilotScenario = (harness: {
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
  "model",
  "scenario",
  "github_copilot.model",
  "github_copilot.provider_type",
  "github_copilot.end_reason",
  "gen_ai.tool.name",
  "gen_ai.tool.call.id",
  "mcp.server",
  "github_copilot.agent_name",
] as const;

function snapshotFields(event: CapturedLogEvent): SpanTreeFields {
  const fields = spanTreeFields(event);
  const metadata =
    fields.metadata &&
    typeof fields.metadata === "object" &&
    !Array.isArray(fields.metadata)
      ? Object.fromEntries(
          Object.entries(fields.metadata).filter(([key]) =>
            SNAPSHOT_METADATA_KEYS.includes(
              key as (typeof SNAPSHOT_METADATA_KEYS)[number],
            ),
          ),
        )
      : undefined;

  if (metadata && typeof metadata["gen_ai.tool.call.id"] === "string") {
    metadata["gen_ai.tool.call.id"] = "<tool-call-id>";
  }

  const metrics =
    fields.metrics &&
    typeof fields.metrics === "object" &&
    !Array.isArray(fields.metrics)
      ? ({ ...fields.metrics } as Record<string, unknown>)
      : undefined;
  if (metrics) {
    delete metrics.prompt_cached_tokens;
  }

  return {
    ...fields,
    metadata,
    metrics,
  };
}

function buildSpanTree(events: CapturedLogEvent[]): SpanTreeEntry[] {
  const root = findLatestSpan(events, ROOT_NAME);
  const basicOperation = findLatestSpan(
    events,
    "github-copilot-basic-operation",
  );
  const toolOperation = findLatestSpan(events, "github-copilot-tool-operation");

  const basicSession = findChildSpans(
    events,
    "Copilot Session",
    basicOperation?.span.id,
  ).at(-1);
  const toolSession = findChildSpans(
    events,
    "Copilot Session",
    toolOperation?.span.id,
  ).at(-1);

  const basicTurn = findChildSpans(
    events,
    "Copilot Turn",
    basicSession?.span.id,
  ).at(-1);
  const toolTurn = findChildSpans(
    events,
    "Copilot Turn",
    toolSession?.span.id,
  ).at(-1);

  const basicLlm = findChildSpans(
    events,
    "github.copilot.llm",
    basicTurn?.span.id,
  ).at(-1);

  const toolLlm = findChildSpans(
    events,
    "github.copilot.llm",
    toolTurn?.span.id,
  ).at(-1);

  const toolTurns = findChildSpans(
    events,
    "Copilot Turn",
    toolSession?.span.id,
  );
  const toolTurnIds = new Set(toolTurns.map((event) => event.span.id));
  const toolSpan = events
    .filter(
      (event) =>
        event.span.type === "tool" &&
        (event.span.name?.includes("get_weather") ?? false) &&
        (event.span.parentIds.some((parentId) => toolTurnIds.has(parentId)) ||
          event.span.parentIds.includes(toolSession?.span.id ?? "")),
    )
    .at(-1);

  return [
    root,
    basicOperation,
    basicSession,
    basicTurn,
    basicLlm,
    toolOperation,
    toolSession,
    toolTurn,
    toolLlm,
    toolSpan,
  ].map((event) => ({
    event: event!,
    fields: snapshotFields(event!),
  }));
}

export function defineGitHubCopilotInstrumentationAssertions(options: {
  name: string;
  runScenario: RunCopilotScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const testConfig = { timeout: options.timeoutMs };

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

    test(
      "captures session and turn spans for basic operation",
      testConfig,
      () => {
        const operation = findLatestSpan(
          events,
          "github-copilot-basic-operation",
        );
        const session = findChildSpans(
          events,
          "Copilot Session",
          operation?.span.id,
        ).at(-1);
        const turn = findChildSpans(
          events,
          "Copilot Turn",
          session?.span.id,
        ).at(-1);

        expect(operation).toBeDefined();
        expect(session).toBeDefined();
        expect(session?.span.type).toBe("task");
        expect(turn).toBeDefined();
        expect(turn?.span.type).toBe("task");
      },
    );

    test(
      "captures LLM span with metrics for basic operation",
      testConfig,
      () => {
        const session = findChildSpans(
          events,
          "Copilot Session",
          findLatestSpan(events, "github-copilot-basic-operation")?.span.id,
        ).at(-1);
        const turn = findChildSpans(
          events,
          "Copilot Turn",
          session?.span.id,
        ).at(-1);
        const llm = findChildSpans(
          events,
          "github.copilot.llm",
          turn?.span.id,
        ).at(-1);

        expect(llm).toBeDefined();
        expect(llm?.span.type).toBe("llm");
        expect(llm?.row.metadata).toMatchObject({
          model: expect.any(String),
        });
        expect(llm?.metrics?.prompt_tokens).toBeGreaterThan(0);
        expect(llm?.metrics?.completion_tokens).toBeGreaterThan(0);
        expect(llm?.metrics?.tokens).toBeGreaterThan(0);
      },
    );

    test("captures tool span for tool-using operation", testConfig, () => {
      const session = findChildSpans(
        events,
        "Copilot Session",
        findLatestSpan(events, "github-copilot-tool-operation")?.span.id,
      ).at(-1);
      const turns = findChildSpans(events, "Copilot Turn", session?.span.id);
      const turnIds = new Set(turns.map((event) => event.span.id));

      const toolSpan = events
        .filter(
          (event) =>
            event.span.type === "tool" &&
            (event.span.name?.includes("get_weather") ?? false) &&
            (event.span.parentIds.some((parentId) => turnIds.has(parentId)) ||
              event.span.parentIds.includes(session?.span.id ?? "")),
        )
        .at(-1);

      expect(toolSpan).toBeDefined();
      expect(toolSpan?.span.type).toBe("tool");
    });

    test("matches the span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(events, snapshotPath);
    });
  });
}
