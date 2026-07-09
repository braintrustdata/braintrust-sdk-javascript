import { beforeAll, describe, expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findChildSpans,
  findLatestChildSpan,
  findLatestSpan,
} from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const spanTreeSnapshotPath = resolveFileSnapshotPath(
  import.meta.url,
  "eve-instrumentation.span-tree.json",
);
const TIMEOUT_MS = 120_000;

describe("eve instrumentation", () => {
  let events: CapturedLogEvent[] = [];

  beforeAll(async () => {
    await withScenarioHarness(
      async ({ events: harnessEvents, runScenarioDir }) => {
        await runScenarioDir({
          entry: "scenario.ts",
          env: {
            NODE_ENV: "development",
          },
          runContext: {
            originalScenarioDir,
            variantKey: "eve-v0-20-0",
          },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
        events = harnessEvents();
      },
    );
  }, TIMEOUT_MS);

  test("captures a nested Eve local subagent trace", async () => {
    const root = findLatestSpan(events, "eve.turn");
    const steps = findChildSpans(events, "eve.step", root?.span.id);
    const researcher = findChildSpans(events, "researcher", root?.span.id)[0];
    const childTurn = findChildSpans(
      events,
      "eve.turn",
      researcher?.span.id,
    )[0];
    const childSteps = findChildSpans(events, "eve.step", childTurn?.span.id);
    const childSearch = findLatestChildSpan(
      events,
      "search",
      childTurn?.span.id,
    );
    const read = findLatestChildSpan(events, "read", root?.span.id);

    expect(root).toBeDefined();
    expect(root?.span.type).toBe("task");
    expect(root?.span.parentIds).toEqual([]);
    expect(root?.metadata).toMatchObject({
      scenario: "eve-instrumentation",
      testRunId: expect.any(String),
    });
    expect(root?.metrics?.completion_tokens).toEqual(expect.any(Number));
    expect(root?.metrics?.prompt_tokens).toEqual(expect.any(Number));
    expect(root?.metrics?.tokens).toEqual(expect.any(Number));
    expect(root?.output).toContain("Final answer from read");

    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.span.type)).toEqual(["llm", "llm", "llm"]);
    for (const step of steps) {
      expect(step.span.parentIds).toEqual([root?.span.id]);
      expect(step.input).toMatchObject({
        messages: expect.any(Array),
      });
      expect(step.metadata).toMatchObject({
        model: "gpt-5.4-mini",
        provider: "openai",
        scenario: "eve-instrumentation",
        testRunId: expect.any(String),
      });
    }

    expect(researcher).toBeDefined();
    expect(researcher?.span.type).toBe("tool");
    expect(researcher?.span.ended).toBe(true);
    expect(researcher?.span.parentIds).toEqual([root?.span.id]);
    expect(researcher?.input).toMatchObject({
      message: expect.stringContaining("Braintrust Eve instrumentation"),
    });
    expect(researcher?.metadata).toMatchObject({
      scenario: "eve-instrumentation",
      testRunId: expect.any(String),
    });
    expect(researcher?.output).toContain("Researcher result");

    expect(childTurn).toBeDefined();
    expect(childTurn?.span.parentIds).toEqual([researcher?.span.id]);
    expect(childTurn?.span.rootId).toEqual(root?.span.rootId);
    expect(childTurn?.metadata).toMatchObject({
      scenario: "eve-instrumentation",
      testRunId: expect.any(String),
    });

    expect(childSteps).toHaveLength(2);
    for (const step of childSteps) {
      expect(step.span.type).toBe("llm");
      expect(step.span.parentIds).toEqual([childTurn?.span.id]);
      expect(step.input).toMatchObject({
        messages: expect.any(Array),
      });
      expect(step.metadata).toMatchObject({
        model: "gpt-5.4-mini",
        provider: "openai",
        scenario: "eve-instrumentation",
        testRunId: expect.any(String),
      });
    }

    expect(childSearch).toBeDefined();
    expect(childSearch?.span.type).toBe("tool");
    expect(childSearch?.span.ended).toBe(true);
    expect(childSearch?.span.parentIds).toEqual([childTurn?.span.id]);
    expect(childSearch?.input).toMatchObject({
      query: expect.stringContaining("Braintrust Eve instrumentation"),
    });
    expect(childSearch?.output).toMatchObject({
      title: "Eve instrumentation",
    });

    expect(read).toBeDefined();
    expect(read?.span.type).toBe("tool");
    expect(read?.span.ended).toBe(true);
    expect(read?.span.parentIds).toEqual([root?.span.id]);
    expect(read?.input).toMatchObject({
      url: "https://eve.dev/docs/guides/instrumentation",
    });
    expect(read?.output).toMatchObject({
      section: "Runtime context",
      title: "Eve instrumentation",
    });

    await matchSpanTreeSnapshot(events, spanTreeSnapshotPath);
  });
});
