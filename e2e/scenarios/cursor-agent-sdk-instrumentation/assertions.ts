import { beforeAll, describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  effectiveScenarioTimeoutMs,
  withScenarioHarness,
  type ScenarioRunContext,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import {
  findAllSpans,
  findChildSpans,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import { ROOT_NAME, SCENARIO_NAME } from "./scenario.impl.mjs";

type RunScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env: Record<string, string>;
    nodeArgs: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const METADATA_KEYS = [
  "agent_sdk.session_id",
  "agent_sdk.turn_id",
  "agent_sdk.turn_status",
  "cursor_sdk.agent_id",
  "cursor_sdk.delta_tokens",
  "cursor_sdk.model",
  "cursor_sdk.request_id",
  "cursor_sdk.run_id",
  "cursor_sdk.runtime",
  "cursor_sdk.status",
  "cursor_sdk.step_duration_ms",
  "cursor_sdk.steps",
  "cursor_sdk.tool.args_truncated",
  "cursor_sdk.tool.result_truncated",
  "cursor_sdk.tool.status",
  "cursor_sdk.usage_scope",
  "gen_ai.tool.name",
  "model",
  "provider",
  "scenario",
] as const;

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function snapshotFields(event: CapturedLogEvent) {
  const fields = spanTreeFields(event);
  const metadata =
    fields.metadata &&
    typeof fields.metadata === "object" &&
    !Array.isArray(fields.metadata)
      ? Object.fromEntries(
          Object.entries(fields.metadata)
            .filter(([key]) =>
              METADATA_KEYS.includes(key as (typeof METADATA_KEYS)[number]),
            )
            .map(([key, value]) => [key, normalizeMetadata(key, value)]),
        )
      : undefined;
  return {
    ...fields,
    input: normalizePayload(fields.input),
    metadata,
    output: normalizePayload(fields.output),
  };
}

function normalizeMetadata(key: string, value: unknown): unknown {
  if (typeof value === "string" && key.endsWith("_id")) {
    return `<${key}>`;
  }
  return value;
}

function normalizePayload(value: unknown): unknown {
  const text = textOf(value);
  if (text.length > 180) {
    return `<length ${text.length}>`;
  }
  return value;
}

function spansNamed(events: CapturedLogEvent[], name: string) {
  return findAllSpans(events, name);
}

function withDescendants(
  events: CapturedLogEvent[],
  root: CapturedLogEvent | undefined,
): CapturedLogEvent[] {
  const rootId = root?.span.id;
  if (!root || !rootId) {
    return [];
  }
  const children = events.filter((event) =>
    event.span.parentIds.includes(rootId),
  );
  return [root, ...children.flatMap((child) => withDescendants(events, child))];
}

function agentForInput(events: CapturedLogEvent[], marker: string) {
  return spansNamed(events, "Cursor Agent").find((event) =>
    textOf(event.input).includes(marker),
  );
}

export function defineCursorAgentSDKAssertions(options: {
  name: string;
  runScenario: RunScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, timeoutMs);

    test("records the application root", () => {
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
    });

    test("records the stamp tool and its result", () => {
      const agent = agentForInput(events, "BRAINTRUST_STAMP_OK");
      expect(agent?.span.id).toBeDefined();
      const tool = findChildSpans(events, "tool: stamp", agent?.span.id).at(-1);
      expect(tool).toBeDefined();
      expect(textOf(tool?.output)).toContain("STAMP:");
      expect(textOf(tool?.output)).toContain("BRAINTRUST_STAMP_OK");
    });

    test("records the follow-up on the same session", () => {
      const first = agentForInput(events, "BRAINTRUST_STAMP_OK");
      const second = agentForInput(events, "FOLLOWUP");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first?.metadata?.["agent_sdk.session_id"]).toBeTruthy();
      expect(second?.metadata?.["agent_sdk.session_id"]).toBe(
        first?.metadata?.["agent_sdk.session_id"],
      );
      expect(second?.metadata?.["agent_sdk.turn_id"]).toBeTruthy();
      expect(second?.metadata?.["agent_sdk.turn_id"]).not.toBe(
        first?.metadata?.["agent_sdk.turn_id"],
      );
      expect(textOf(second?.output)).toContain("FOLLOWUP_OK");
    });

    test("records the subagent call", () => {
      const agent = agentForInput(events, "DELEGATE");
      expect(agent).toBeDefined();
      const task = findChildSpans(events, "tool: task", agent?.span.id).at(-1);
      expect(task?.span.id).toBeDefined();
      const subagent = [...events]
        .reverse()
        .find(
          (event) =>
            event.span.name?.startsWith("Agent:") &&
            event.span.parentIds.includes(task?.span.id ?? ""),
        );
      expect(subagent).toBeDefined();
      expect(textOf(agent?.output)).toContain("SUBAGENT_OK");
    });

    test("records the tool failure", () => {
      const agent = agentForInput(events, "FAIL");
      const tool = findChildSpans(events, "tool: fail_tool", agent?.span.id).at(
        -1,
      );
      expect(tool).toBeDefined();
      expect(textOf(tool?.row.error) || textOf(tool?.output)).toContain(
        "fail_tool exploded",
      );
    });

    test("records cancellation without inventing an error message", () => {
      const agent = agentForInput(events, "HANG");
      expect(agent).toBeDefined();
      expect(agent?.metadata?.["cursor_sdk.status"]).toBe("cancelled");
      expect(textOf(agent?.row.error)).not.toContain("Unknown error");
      const tool = findChildSpans(events, "tool: hang", agent?.span.id).at(-1);
      expect(tool).toBeDefined();
      expect(tool?.metadata?.["cursor_sdk.tool.status"]).toBe("cancelled");
    });

    test("marks finished tools as completed", () => {
      const agent = agentForInput(events, "BRAINTRUST_STAMP_OK");
      const tool = findChildSpans(events, "tool: stamp", agent?.span.id).at(-1);
      expect(tool?.metadata?.["cursor_sdk.tool.status"]).toBe("completed");
    });

    test("keeps concurrent sessions from parenting each other", () => {
      const sessionA = agentForInput(events, "SESSION_A");
      const sessionB = agentForInput(events, "SESSION_B");
      expect(sessionA?.span.id).toBeDefined();
      expect(sessionB?.span.id).toBeDefined();
      expect(sessionA?.span.parentIds).not.toContain(sessionB?.span.id);
      expect(sessionB?.span.parentIds).not.toContain(sessionA?.span.id);
      expect(sessionA?.metadata?.["agent_sdk.session_id"]).not.toBe(
        sessionB?.metadata?.["agent_sdk.session_id"],
      );
      const root = findLatestSpan(events, ROOT_NAME);
      expect(sessionA?.span.parentIds).toContain(root?.span.id);
      expect(sessionB?.span.parentIds).toContain(root?.span.id);
      expect(
        findChildSpans(events, "tool: stamp", sessionA?.span.id).length,
      ).toBeGreaterThan(0);
      expect(
        findChildSpans(events, "tool: stamp", sessionB?.span.id).length,
      ).toBeGreaterThan(0);
    });

    test("preserves a long tool result or the SDK truncation flag", () => {
      const agent = agentForInput(events, "LONG");
      const tool = findChildSpans(events, "tool: long_text", agent?.span.id).at(
        -1,
      );
      expect(tool).toBeDefined();
      const output = textOf(tool?.output);
      const truncated = tool?.metadata?.["cursor_sdk.tool.result_truncated"];
      if (output.length > 2048) {
        expect(truncated).not.toBe(true);
        expect(output).toContain("LONG_MARKER");
      } else {
        expect(truncated).toBe(true);
        expect(output.length).toBeGreaterThan(0);
      }
    });

    test("matches the span tree", async () => {
      const interesting = [
        findLatestSpan(events, ROOT_NAME),
        agentForInput(events, "BRAINTRUST_STAMP_OK"),
        ...spansNamed(events, "tool: stamp").slice(0, 1),
        agentForInput(events, "FOLLOWUP"),
        agentForInput(events, "DELEGATE"),
        ...withDescendants(
          events,
          findChildSpans(
            events,
            "tool: task",
            agentForInput(events, "DELEGATE")?.span.id,
          ).at(-1),
        ),
        agentForInput(events, "FAIL"),
        ...spansNamed(events, "tool: fail_tool").slice(0, 1),
        agentForInput(events, "LONG"),
        ...spansNamed(events, "tool: long_text").slice(0, 1),
        agentForInput(events, "HANG"),
        ...spansNamed(events, "tool: hang").slice(0, 1),
        agentForInput(events, "SESSION_A"),
        agentForInput(events, "SESSION_B"),
        ...findChildSpans(
          events,
          "tool: stamp",
          agentForInput(events, "SESSION_B")?.span.id,
        ).slice(0, 1),
      ].flatMap((event) =>
        event ? [{ event, fields: snapshotFields(event) }] : [],
      );
      expect(interesting.length).toBeGreaterThanOrEqual(14);
      await matchSpanTreeSnapshot(interesting, snapshotPath);
    });
  });
}
