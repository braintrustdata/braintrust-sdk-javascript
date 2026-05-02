import { beforeAll, describe, expect, test } from "vitest";
import { normalizeForSnapshot, type Json } from "../../helpers/normalize";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  formatJsonFileSnapshot,
  resolveFileSnapshotPath,
} from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";
import { summarizeWrapperContract } from "../../helpers/wrapper-contract";
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

type RunCopilotScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    nodeArgs: string[];
    runContext?: { variantKey: string };
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    runContext?: { variantKey: string };
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

function summarizeSpan(event: CapturedLogEvent | undefined): Json {
  if (!event) {
    return null;
  }

  const summary = summarizeWrapperContract(event, [
    ...SNAPSHOT_METADATA_KEYS,
  ]) as Record<string, Json>;

  // Normalize non-deterministic IDs in metadata
  if (summary.metadata && typeof summary.metadata === "object") {
    const metadata = summary.metadata as Record<string, Json>;
    if (typeof metadata["gen_ai.tool.call.id"] === "string") {
      metadata["gen_ai.tool.call.id"] = "<tool-call-id>";
    }
  }

  return summary;
}

function buildSpanSummary(events: CapturedLogEvent[]): Json {
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

  const toolSpan = events.find(
    (event) =>
      event.span.type === "tool" &&
      (event.span.parentIds.includes(toolTurn?.span.id ?? "") ||
        event.span.parentIds.includes(toolSession?.span.id ?? "")),
  );

  return normalizeForSnapshot({
    root: summarizeSpan(root),
    basic: {
      operation: summarizeSpan(basicOperation),
      session: summarizeSpan(basicSession),
      turn: summarizeSpan(basicTurn),
      llm: summarizeSpan(basicLlm),
    },
    tool: {
      operation: summarizeSpan(toolOperation),
      session: summarizeSpan(toolSession),
      turn: summarizeSpan(toolTurn),
      llm: summarizeSpan(toolLlm),
      tool: summarizeSpan(toolSpan),
    },
  } as Json);
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
    `${options.snapshotName}.span-events.json`,
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
      const turn = findChildSpans(events, "Copilot Turn", session?.span.id).at(
        -1,
      );

      const toolSpan = events.find(
        (event) =>
          event.span.type === "tool" &&
          (event.span.name?.includes("get_weather") ?? false) &&
          (event.span.parentIds.includes(turn?.span.id ?? "") ||
            event.span.parentIds.includes(session?.span.id ?? "")),
      );

      expect(toolSpan).toBeDefined();
      expect(toolSpan?.span.type).toBe("tool");
    });

    test("matches the span snapshot", testConfig, async () => {
      await expect(
        formatJsonFileSnapshot(buildSpanSummary(events)),
      ).toMatchFileSnapshot(snapshotPath);
    });
  });
}
