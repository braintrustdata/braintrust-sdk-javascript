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
            variantKey: "eve-v0-20-0",
          },
          scenarioDir,
          timeoutMs: TIMEOUT_MS,
        });
        events = harnessEvents();
      },
    );
  }, TIMEOUT_MS);

  test("captures user turns as traces with subagent turns attached", async () => {
    const turns = findAllSpans(events, "eve.turn");
    const root = turns.find(
      (turn) =>
        Array.isArray(turn.input) &&
        turn.input[0]?.content ===
          "Run the Braintrust Eve instrumentation e2e scenario",
    );
    const secondRoot = turns.find(
      (turn) =>
        Array.isArray(turn.input) &&
        turn.input[0]?.content ===
          "Run the Braintrust Eve instrumentation e2e scenario again",
    );
    const steps = findChildSpans(events, "eve.step", root?.span.id);
    const researcher = findChildSpans(events, "researcher", root?.span.id)[0];
    const childTurn = turns.find(
      (turn) =>
        Array.isArray(turn.input) &&
        String(turn.input[0]?.content).includes(
          "Caller message:\nRun the Braintrust Eve instrumentation e2e scenario",
        ) &&
        !String(turn.input[0]?.content).includes("scenario again"),
    );
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
    const secondChildTurn = turns.find(
      (turn) =>
        Array.isArray(turn.input) &&
        String(turn.input[0]?.content).includes(
          "Caller message:\nRun the Braintrust Eve instrumentation e2e scenario again",
        ),
    );
    const secondRead = findLatestChildSpan(events, "read", secondRoot?.span.id);

    expect(findAllSpans(events, "eve.session")).toEqual([]);
    expect(turns).toHaveLength(4);
    expect(
      turns.filter((turn) => turn.span.parentIds.length === 0),
    ).toHaveLength(2);
    expect(new Set(turns.map((turn) => turn.span.rootId)).size).toBe(2);

    expect(root).toBeDefined();
    expect(root?.span.type).toBe("task");
    expect(root?.span.parentIds).toEqual([]);
    expect(root?.metadata).toMatchObject({
      "eve.session_id": expect.any(String),
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
        "eve.session_id": root?.metadata?.["eve.session_id"],
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
      "eve.session_id": root?.metadata?.["eve.session_id"],
      scenario: "eve-instrumentation",
      testRunId: expect.any(String),
    });
    expect(researcher?.output).toContain("Researcher result");

    expect(childTurn).toBeDefined();
    expect(childTurn?.span.parentIds).toEqual([researcher?.span.id]);
    expect(childTurn?.span.rootId).toEqual(root?.span.rootId);
    expect(childTurn?.metadata).toMatchObject({
      "eve.session_id": expect.any(String),
      scenario: "eve-instrumentation",
      testRunId: expect.any(String),
    });
    expect(childTurn?.metadata?.["eve.session_id"]).not.toEqual(
      root?.metadata?.["eve.session_id"],
    );

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
        "eve.session_id": childTurn?.metadata?.["eve.session_id"],
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
    expect(childSearch?.metadata).toMatchObject({
      "eve.session_id": childTurn?.metadata?.["eve.session_id"],
    });
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
    expect(read?.metadata).toMatchObject({
      "eve.session_id": root?.metadata?.["eve.session_id"],
    });
    expect(read?.input).toMatchObject({
      url: "https://eve.dev/docs/guides/instrumentation",
    });
    expect(read?.output).toMatchObject({
      section: "Runtime context",
      title: "Eve instrumentation",
    });

    expect(secondRoot).toBeDefined();
    expect(secondRoot?.span.type).toBe("task");
    expect(secondRoot?.span.parentIds).toEqual([]);
    expect(secondRoot?.span.rootId).not.toEqual(root?.span.rootId);
    expect(secondRoot?.metadata).toMatchObject({
      "eve.session_id": root?.metadata?.["eve.session_id"],
    });
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
    expect(secondResearcher?.metadata).toMatchObject({
      "eve.session_id": secondRoot?.metadata?.["eve.session_id"],
    });
    expect(secondChildTurn?.span.parentIds).toEqual([
      secondResearcher?.span.id,
    ]);
    expect(secondChildTurn?.span.rootId).toEqual(secondRoot?.span.rootId);
    expect(secondChildTurn?.metadata).toMatchObject({
      "eve.session_id": expect.any(String),
    });
    expect(secondChildTurn?.metadata?.["eve.session_id"]).not.toEqual(
      secondRoot?.metadata?.["eve.session_id"],
    );
    expect(secondRead?.span.type).toBe("tool");
    expect(secondRead?.span.ended).toBe(true);
    expect(secondRead?.span.parentIds).toEqual([secondRoot?.span.id]);
    expect(secondRead?.metadata).toMatchObject({
      "eve.session_id": secondRoot?.metadata?.["eve.session_id"],
    });

    await matchSpanTreeSnapshot(events, spanTreeSnapshotPath, {
      normalize: {
        additionalProviderIdKeys: ["eve.session_id"],
      },
    });
  });
});
