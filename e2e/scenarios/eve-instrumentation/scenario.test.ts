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
  findAllSpans,
  findChildSpans,
  findLatestChildSpan,
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
            variantKey: "eve-v0-22-1",
          },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
        events = harnessEvents();
      },
    );
  }, TIMEOUT_MS);

  test("captures multiple nested turns in one Eve session", async () => {
    const session = findAllSpans(events, "eve.session").find(
      (span) => span.span.parentIds.length === 0,
    );
    const turns = findChildSpans(events, "eve.turn", session?.span.id);
    const [root, secondRoot] = turns;
    const steps = findChildSpans(events, "eve.step", root?.span.id);
    const researcher = findChildSpans(events, "researcher", root?.span.id)[0];
    const childSession = findChildSpans(
      events,
      "eve.session",
      researcher?.span.id,
    )[0];
    const childTurn = findChildSpans(
      events,
      "eve.turn",
      childSession?.span.id,
    )[0];
    const childSteps = findChildSpans(events, "eve.step", childTurn?.span.id);
    const childSearch = findLatestChildSpan(
      events,
      "search",
      childTurn?.span.id,
    );
    const read = findLatestChildSpan(events, "read", root?.span.id);
    const secondSteps = findChildSpans(events, "eve.step", secondRoot?.span.id);
    const secondResearcher = findLatestChildSpan(
      events,
      "researcher",
      secondRoot?.span.id,
    );
    const secondChildSession = findLatestChildSpan(
      events,
      "eve.session",
      secondResearcher?.span.id,
    );
    const secondChildTurn = findLatestChildSpan(
      events,
      "eve.turn",
      secondChildSession?.span.id,
    );
    const secondRead = findLatestChildSpan(events, "read", secondRoot?.span.id);

    expect(session).toBeDefined();
    expect(session?.span.type).toBe("task");
    expect(session?.span.parentIds).toEqual([]);
    expect(session?.metadata).toMatchObject({
      scenario: "eve-instrumentation",
      testRunId: expect.any(String),
    });
    expect(session?.metadata).not.toHaveProperty("model");
    expect(session?.metadata).not.toHaveProperty("provider");
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.span.parentIds)).toEqual([
      [session?.span.id],
      [session?.span.id],
    ]);
    expect(turns.map((turn) => turn.input)).toEqual([
      [
        {
          content: "Run the Braintrust Eve instrumentation e2e scenario",
          role: "user",
        },
      ],
      [
        {
          content: "Run the Braintrust Eve instrumentation e2e scenario again",
          role: "user",
        },
      ],
    ]);

    expect(root).toBeDefined();
    expect(root?.span.type).toBe("task");
    expect(root?.span.parentIds).toEqual([session?.span.id]);
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
      expect(Array.isArray(step.input)).toBe(true);
      if (!Array.isArray(step.input)) {
        throw new Error("Expected Eve step input to be a message array");
      }
      expect(step.input[0]).toMatchObject({ role: "system" });
      expect(step.metadata).toMatchObject({
        model: "deepseek-v4-pro",
        provider: "deepseek",
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

    expect(childSession).toBeDefined();
    expect(childSession?.span.parentIds).toEqual([researcher?.span.id]);
    expect(childSession?.span.rootId).toEqual(session?.span.rootId);

    expect(childTurn).toBeDefined();
    expect(childTurn?.span.parentIds).toEqual([childSession?.span.id]);
    expect(childTurn?.span.rootId).toEqual(root?.span.rootId);
    expect(childTurn?.metadata).toMatchObject({
      scenario: "eve-instrumentation",
      testRunId: expect.any(String),
    });

    expect(childSteps).toHaveLength(2);
    for (const step of childSteps) {
      expect(step.span.type).toBe("llm");
      expect(step.span.parentIds).toEqual([childTurn?.span.id]);
      expect(Array.isArray(step.input)).toBe(true);
      if (!Array.isArray(step.input)) {
        throw new Error("Expected Eve step input to be a message array");
      }
      expect(step.input[0]).toMatchObject({ role: "system" });
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

    expect(secondRoot).toBeDefined();
    expect(secondRoot?.span.type).toBe("task");
    expect(secondRoot?.output).toContain("Final answer from read");
    expect(secondSteps).toHaveLength(3);
    expect(secondSteps.map((step) => step.span.type)).toEqual([
      "llm",
      "llm",
      "llm",
    ]);
    expect(secondResearcher?.span.type).toBe("tool");
    expect(secondResearcher?.span.ended).toBe(true);
    expect(secondResearcher?.span.parentIds).toEqual([secondRoot?.span.id]);
    expect(secondChildSession?.span.parentIds).toEqual([
      secondResearcher?.span.id,
    ]);
    expect(secondChildTurn?.span.parentIds).toEqual([
      secondChildSession?.span.id,
    ]);
    expect(secondRead?.span.type).toBe("tool");
    expect(secondRead?.span.ended).toBe(true);
    expect(secondRead?.span.parentIds).toEqual([secondRoot?.span.id]);

    await matchSpanTreeSnapshot(events, spanTreeSnapshotPath);
  });
});
