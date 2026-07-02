import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
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
  type SpanTreeFields,
} from "../../helpers/span-tree";
import {
  findAllSpans,
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";
import { SCENARIO_NAME } from "./constants.mjs";

type RunFlueScenario = (harness: {
  runNodeScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    nodeArgs?: string[];
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
  runScenarioDir: (options: {
    entry: string;
    env?: Record<string, string>;
    runContext?: ScenarioRunContext;
    scenarioDir: string;
    timeoutMs: number;
  }) => Promise<unknown>;
}) => Promise<void>;

const SNAPSHOT_METADATA_KEYS = [
  "provider",
  "model",
  "scenario",
  "flue.api",
  "flue.compaction_reason",
  "flue.model",
  "flue.operation",
  "flue.provider",
  "flue.session",
  "flue.stop_reason",
  "flue.tool_name",
  "flue.turn_purpose",
  "flue.workflow_name",
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

  return {
    ...fields,
    metadata,
  };
}

function findFlueOperation(events: CapturedLogEvent[], flueSpanName: string) {
  const workflow = findLatestSpanByPrefix(events, "workflow:");
  return findLatestChildSpan(events, flueSpanName, workflow?.span.id);
}

function findLatestSpanByPrefix(
  events: CapturedLogEvent[],
  prefix: string,
): CapturedLogEvent | undefined {
  return [...events]
    .reverse()
    .find((event) => event.span.name?.startsWith(prefix));
}

function findMatchingDescendants(
  events: CapturedLogEvent[],
  ancestor: CapturedLogEvent | undefined,
  predicate: (event: CapturedLogEvent) => boolean,
): CapturedLogEvent[] {
  if (!ancestor) {
    return [];
  }
  const visited = new Set<string>();
  const matches: CapturedLogEvent[] = [];
  let frontier = [ancestor.span.id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const children = events.filter((event) =>
        event.span.parentIds.includes(parentId),
      );
      for (const child of children) {
        if (child.span.id && !visited.has(child.span.id)) {
          visited.add(child.span.id);
          if (predicate(child)) {
            matches.push(latestSpanEvent(events, child.span.id) ?? child);
          }
          next.push(child.span.id);
        }
      }
    }
    frontier = next;
  }
  return matches.sort(
    (left, right) =>
      firstSpanIndex(events, left) - firstSpanIndex(events, right),
  );
}

function latestSpanEvent(
  events: CapturedLogEvent[],
  spanId: string | undefined,
): CapturedLogEvent | undefined {
  if (!spanId) {
    return undefined;
  }
  return [...events].reverse().find((event) => event.span.id === spanId);
}

function firstSpanIndex(
  events: CapturedLogEvent[],
  event: CapturedLogEvent,
): number {
  if (!event.span.id) {
    return Number.MAX_SAFE_INTEGER;
  }
  const index = events.findIndex(
    (candidate) => candidate.span.id === event.span.id,
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function findFlueDescendants(
  events: CapturedLogEvent[],
  flueSpan: CapturedLogEvent | undefined,
  predicate: (event: CapturedLogEvent) => boolean,
): CapturedLogEvent[] {
  return findMatchingDescendants(events, flueSpan, predicate);
}

function isFlueChildSpan(
  event: CapturedLogEvent,
  includeAmbientProbeSpans = true,
): boolean {
  return (
    event.span.name?.startsWith("llm:") === true ||
    event.span.name?.startsWith("tool:") === true ||
    event.span.name?.startsWith("task:") === true ||
    event.span.name?.startsWith("compaction:") === true ||
    (includeAmbientProbeSpans && event.span.name === "flue.toolCurrentProbe") ||
    event.span.name === "flue.task"
  );
}

function buildSpanTree(
  events: CapturedLogEvent[],
  includeAmbientProbeSpans: boolean,
): SpanTreeEntry[] {
  const workflow = findLatestSpanByPrefix(events, "workflow:");
  const workflowCurrentProbe = includeAmbientProbeSpans
    ? findLatestChildSpan(
        events,
        "flue.workflowCurrentProbe",
        workflow?.span.id,
      )
    : undefined;
  const promptSpan = findFlueOperation(events, "flue.prompt");
  const skillSpan = findFlueOperation(events, "flue.skill");
  const taskSpan = findFlueOperation(events, "flue.task");
  const compactSpan = findFlueOperation(events, "flue.compact");

  return [
    workflow,
    workflowCurrentProbe,
    promptSpan,
    ...findFlueDescendants(events, promptSpan, (event) =>
      isFlueChildSpan(event, includeAmbientProbeSpans),
    ),
    skillSpan,
    ...findFlueDescendants(events, skillSpan, (event) =>
      isFlueChildSpan(event, includeAmbientProbeSpans),
    ),
    taskSpan,
    ...findFlueDescendants(events, taskSpan, (event) =>
      isFlueChildSpan(event, includeAmbientProbeSpans),
    ),
    compactSpan,
    ...findFlueDescendants(events, compactSpan, (event) =>
      isFlueChildSpan(event, includeAmbientProbeSpans),
    ),
  ].flatMap((event) =>
    event ? [{ event, fields: snapshotFields(event) }] : [],
  );
}

export function defineFlueInstrumentationAssertions(options: {
  expectAmbientContext?: boolean;
  name: string;
  runScenario: RunFlueScenario;
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  const snapshotPath = resolveFileSnapshotPath(
    options.testFileUrl,
    `${options.snapshotName}.span-tree.json`,
  );
  const timeoutMs = effectiveScenarioTimeoutMs(options.timeoutMs);
  const testConfig = { timeout: timeoutMs };
  const expectAmbientContext = options.expectAmbientContext ?? true;

  describe.sequential(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, timeoutMs);

    test("captures the root trace", testConfig, () => {
      const root = findLatestSpanByPrefix(events, "workflow:");

      expect(root).toBeDefined();
      expect(root?.input).toMatchObject({ scenario: SCENARIO_NAME });
      expect(root?.row.metadata).toMatchObject({
        "flue.workflow_name": "instrumentation",
        provider: "flue",
        scenario: SCENARIO_NAME,
        testRunId: expect.any(String),
      });
    });

    if (expectAmbientContext) {
      test(
        "makes the Flue workflow span current for app spans",
        testConfig,
        () => {
          const workflow = findLatestSpanByPrefix(events, "workflow:");
          const appSpan = findLatestChildSpan(
            events,
            "flue.workflowCurrentProbe",
            workflow?.span.id,
          );

          expect(appSpan).toBeDefined();
          expect(appSpan?.span.parentIds).toEqual([workflow?.span.id]);
          expect(appSpan?.output).toBe("active");
        },
      );

      test("makes Flue tool spans current for app spans", testConfig, () => {
        const workflow = findLatestSpanByPrefix(events, "workflow:");
        const promptSpan = findFlueOperation(events, "flue.prompt");
        const lookupToolSpan = findFlueDescendants(
          events,
          promptSpan,
          (event) => event.span.name === "tool:lookup",
        )[0];
        const appSpan = findLatestChildSpan(
          events,
          "flue.toolCurrentProbe",
          lookupToolSpan?.span.id,
        );

        expect(appSpan).toBeDefined();
        expect(appSpan?.span.parentIds).toEqual([lookupToolSpan?.span.id]);
        expect(appSpan?.output).toBe("lookup-active");
        expect(workflow).toBeDefined();
      });
    }

    test("captures observe-based Flue operation spans", testConfig, () => {
      for (const flueSpanName of [
        "flue.prompt",
        "flue.skill",
        "flue.compact",
      ] as const) {
        const span = findFlueOperation(events, flueSpanName);

        expect(span).toBeDefined();
        expect(span?.span.type).toBe("task");
        expect(span?.input).toBeDefined();
        expect(span?.output).toBeDefined();
        expect(span?.row.metadata).toMatchObject({
          provider: "flue",
        });
      }
      expect(findFlueOperation(events, "flue.prompt")?.output).toBe(
        "PROMPT_DONE",
      );
      expect(findFlueOperation(events, "flue.skill")?.output).toBe(
        "SKILL_DONE",
      );
    });

    test(
      "captures Flue LLM, tool, task, and compaction spans",
      testConfig,
      () => {
        const promptSpan = findFlueOperation(events, "flue.prompt");
        const promptChildren = findFlueDescendants(
          events,
          promptSpan,
          (event) => isFlueChildSpan(event, expectAmbientContext),
        );
        const promptTurns = promptChildren.filter((event) =>
          event.span.name?.startsWith("llm:"),
        );
        const promptTools = promptChildren.filter((event) =>
          event.span.name?.startsWith("tool:"),
        );
        const skillSpan = findFlueOperation(events, "flue.skill");
        const compactSpan = findFlueOperation(events, "flue.compact");
        const allLlmSpans = [promptSpan, skillSpan, compactSpan].flatMap(
          (span) =>
            findFlueDescendants(events, span, (event) =>
              event.span.name?.startsWith("llm:"),
            ),
        );
        const lookupToolSpan = promptTools.find(
          (event) => event.span.name === "tool:lookup",
        );
        const taskSpan = findFlueOperation(events, "flue.task");
        const nestedTaskSpans = findFlueDescendants(
          events,
          taskSpan,
          (event) => event.span.name === "flue.task",
        );
        const compaction = findFlueDescendants(
          events,
          compactSpan,
          (event) => event.span.name?.startsWith("compaction:") === true,
        )[0];

        expect(promptTurns.length).toBeGreaterThan(0);
        expect(allLlmSpans.length).toBeGreaterThan(0);
        for (const llmSpan of allLlmSpans) {
          expect(llmSpan.output).toBeDefined();
          expect(llmSpan.span.ended).toBe(true);
        }
        expect(promptTools.map((event) => event.span.name)).toEqual(
          expect.arrayContaining([
            "tool:lookup",
            "tool:web_search",
            "tool:summarize_source",
          ]),
        );
        expect(promptTurns[0]?.metrics).toMatchObject({
          completion_tokens: expect.any(Number),
          prompt_tokens: expect.any(Number),
          tokens: expect.any(Number),
        });
        expect(lookupToolSpan?.span.type).toBe("tool");
        expect(lookupToolSpan?.input).toMatchObject({
          query: "flue instrumentation",
        });
        expect(JSON.stringify(lookupToolSpan?.output)).toContain(
          "flue-session-2026",
        );
        expect(lookupToolSpan?.span.parentIds).toEqual([promptSpan?.span.id]);
        expect(taskSpan?.span.type).toBe("task");
        expect(taskSpan?.input).toBe(
          "Reply with exactly TASK_DONE and no other text.",
        );
        expect(taskSpan?.output).toBe("TASK_DONE");
        expect(nestedTaskSpans).toHaveLength(0);
        expect(compaction?.span.type).toBe("task");
        expect(compaction?.metadata).toMatchObject({
          "flue.compaction_reason": "manual",
        });
      },
    );

    test("does not instrument session.shell", testConfig, () => {
      expect(findAllSpans(events, "flue.shell")).toHaveLength(0);
    });

    test("matches the span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(
        buildSpanTree(events, expectAmbientContext),
        snapshotPath,
      );
    });
  });
}
