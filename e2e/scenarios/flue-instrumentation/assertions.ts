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
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

type RunFlueScenario = (harness: {
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
  "provider",
  "model",
  "operation",
  "scenario",
  "flue.operation",
  "flue.version",
  "flue.session",
  "flue.model",
  "flue.role",
  "flue.skill_name",
  "flue.thinking",
  "flue.thinking_level",
  "flue.tools_count",
  "flue.tool_name",
  "flue.compaction_reason",
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

function findFlueOperation(
  events: CapturedLogEvent[],
  operationName: string,
  flueSpanName: string,
) {
  const operation = findLatestSpan(events, operationName);
  return findLatestChildSpan(events, flueSpanName, operation?.span.id);
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
  operationSpan: CapturedLogEvent | undefined,
  predicate: (event: CapturedLogEvent) => boolean,
): CapturedLogEvent[] {
  const bySpanId = new Map<string, CapturedLogEvent>();
  for (const event of [
    ...findMatchingDescendants(events, flueSpan, predicate),
    ...findMatchingDescendants(events, operationSpan, predicate),
  ]) {
    if (event.span.id && !bySpanId.has(event.span.id)) {
      bySpanId.set(event.span.id, event);
    }
  }
  return [...bySpanId.values()].sort(
    (left, right) =>
      firstSpanIndex(events, left) - firstSpanIndex(events, right),
  );
}

function isFlueChildSpan(event: CapturedLogEvent): boolean {
  return (
    event.span.name === "flue.turn" ||
    event.span.name === "flue.task" ||
    event.span.name === "flue.compaction" ||
    event.span.name?.startsWith("tool: ") === true
  );
}

function expectToolsAndTurnsShareParent(
  parent: CapturedLogEvent | undefined,
  turns: CapturedLogEvent[],
  tools: CapturedLogEvent[],
): void {
  expect(parent).toBeDefined();
  const parentId = parent?.span.id;
  expect(parentId).toBeDefined();
  if (!parentId) {
    return;
  }
  const turnIds = new Set(
    turns.flatMap((event) => (event.span.id ? [event.span.id] : [])),
  );

  expect(turns.length).toBeGreaterThan(0);
  expect(tools.length).toBeGreaterThan(0);
  expect(turns.every((event) => event.span.parentIds.includes(parentId))).toBe(
    true,
  );
  expect(tools.every((event) => event.span.parentIds.includes(parentId))).toBe(
    true,
  );
  expect(
    tools.some((event) =>
      event.span.parentIds.some((parentId) => turnIds.has(parentId)),
    ),
  ).toBe(false);
}

function buildSpanTree(events: CapturedLogEvent[]): SpanTreeEntry[] {
  const promptOperation = findLatestSpan(events, "flue-prompt-operation");
  const skillOperation = findLatestSpan(events, "flue-skill-operation");
  const taskOperation = findLatestSpan(events, "flue-task-operation");
  const compactOperation = findLatestSpan(events, "flue-compact-operation");
  const promptSpan = findFlueOperation(
    events,
    "flue-prompt-operation",
    "flue.session.prompt",
  );
  const skillSpan = findFlueOperation(
    events,
    "flue-skill-operation",
    "flue.session.skill",
  );
  const taskSpan = findFlueOperation(
    events,
    "flue-task-operation",
    "flue.session.task",
  );
  const compactSpan = findFlueOperation(
    events,
    "flue-compact-operation",
    "flue.session.compact",
  );

  const promptChildren = findFlueDescendants(
    events,
    promptSpan,
    promptOperation,
    isFlueChildSpan,
  );
  const skillChildren = findFlueDescendants(
    events,
    skillSpan,
    skillOperation,
    isFlueChildSpan,
  );
  const taskChildren = findFlueDescendants(
    events,
    taskSpan,
    taskOperation,
    isFlueChildSpan,
  );
  const compactChildren = findFlueDescendants(
    events,
    compactSpan,
    compactOperation,
    isFlueChildSpan,
  );

  return [
    findLatestSpan(events, ROOT_NAME),
    promptOperation,
    promptSpan,
    ...promptChildren,
    skillOperation,
    skillSpan,
    ...skillChildren,
    taskOperation,
    taskSpan,
    ...taskChildren,
    compactOperation,
    compactSpan,
    ...compactChildren,
  ].flatMap((event) =>
    event ? [{ event, fields: snapshotFields(event) }] : [],
  );
}

export function defineFlueInstrumentationAssertions(options: {
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

  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];

    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, timeoutMs);

    test("captures the root trace", testConfig, () => {
      const root = findLatestSpan(events, ROOT_NAME);

      expect(root).toBeDefined();
      expect(root?.row.metadata).toMatchObject({ scenario: SCENARIO_NAME });
    });

    test("captures wrapped Flue operation spans", testConfig, () => {
      for (const [operationName, flueSpanName] of [
        ["flue-prompt-operation", "flue.session.prompt"],
        ["flue-skill-operation", "flue.session.skill"],
        ["flue-task-operation", "flue.session.task"],
        ["flue-compact-operation", "flue.session.compact"],
      ] as const) {
        const operation = findLatestSpan(events, operationName);
        const span = findLatestChildSpan(
          events,
          flueSpanName,
          operation?.span.id,
        );

        expect(operation).toBeDefined();
        expect(span).toBeDefined();
        expect(span?.span.type).toBe("task");
        expect(span?.row.metadata).toMatchObject({
          provider: "flue",
        });
      }
    });

    test(
      "captures Flue child turn, tool, task, and compaction spans",
      testConfig,
      () => {
        const promptSpan = findFlueOperation(
          events,
          "flue-prompt-operation",
          "flue.session.prompt",
        );
        const promptOperation = findLatestSpan(events, "flue-prompt-operation");
        const promptChildren = findFlueDescendants(
          events,
          promptSpan,
          promptOperation,
          isFlueChildSpan,
        );
        const promptTurns = promptChildren.filter(
          (event) => event.span.name === "flue.turn",
        );
        const promptTools = promptChildren.filter((event) =>
          event.span.name?.startsWith("tool: "),
        );
        const lookupToolSpan = promptTools.find(
          (event) => event.span.name === "tool: lookup",
        );
        const reasoningTurn = promptTurns.find((event) =>
          JSON.stringify(event.output).includes('"reasoning"'),
        );
        const skillSpan = findFlueOperation(
          events,
          "flue-skill-operation",
          "flue.session.skill",
        );
        const skillOperation = findLatestSpan(events, "flue-skill-operation");
        const skillChildren = findFlueDescendants(
          events,
          skillSpan,
          skillOperation,
          isFlueChildSpan,
        );
        const skillTurns = skillChildren.filter(
          (event) => event.span.name === "flue.turn",
        );
        const skillTools = skillChildren.filter((event) =>
          event.span.name?.startsWith("tool: "),
        );
        const taskSpan = findFlueOperation(
          events,
          "flue-task-operation",
          "flue.session.task",
        );
        const taskOperation = findLatestSpan(events, "flue-task-operation");
        const childTask = findFlueDescendants(
          events,
          taskSpan,
          taskOperation,
          (event) => event.span.name === "flue.task",
        )[0];
        const compactSpan = findFlueOperation(
          events,
          "flue-compact-operation",
          "flue.session.compact",
        );
        const compactOperation = findLatestSpan(
          events,
          "flue-compact-operation",
        );
        const compaction = findFlueDescendants(
          events,
          compactSpan,
          compactOperation,
          (event) => event.span.name === "flue.compaction",
        )[0];

        expect(promptTurns.length).toBeGreaterThanOrEqual(3);
        expect(promptTools.map((event) => event.span.name)).toEqual(
          expect.arrayContaining([
            "tool: lookup",
            "tool: web_search",
            "tool: summarize_source",
          ]),
        );
        expectToolsAndTurnsShareParent(promptSpan, promptTurns, promptTools);
        expectToolsAndTurnsShareParent(skillSpan, skillTurns, skillTools);
        expect(reasoningTurn?.span.type).toBe("llm");
        expect(reasoningTurn?.output).toBeDefined();
        const reasoningOutput = JSON.stringify(reasoningTurn?.output);
        expect(reasoningOutput).not.toContain("<reasoning>");
        expect(reasoningOutput).not.toContain("content unavailable");
        expect(reasoningOutput).not.toContain("[Reasoning redacted]");
        expect(reasoningTurn?.metadata).toMatchObject({
          "flue.thinking": true,
        });
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
        expect(skillSpan?.output).toBe("SKILL_DONE");
        expect(childTask?.span.type).toBe("task");
        expect(childTask?.input).toBe(
          "Reply with exactly TASK_DONE and no other text.",
        );
        expect(compaction?.span.type).toBe("task");
        expect(compaction?.metadata).toMatchObject({
          "flue.compaction_reason": "manual",
        });
      },
    );

    test("does not instrument session.shell", testConfig, () => {
      expect(findAllSpans(events, "flue.session.shell")).toHaveLength(0);
    });

    test("matches the span tree snapshot", testConfig, async () => {
      await matchSpanTreeSnapshot(buildSpanTree(events), snapshotPath);
    });
  });
}
