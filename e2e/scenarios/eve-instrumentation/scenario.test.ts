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

  test("captures a flat Eve turn trace", async () => {
    const root = findLatestSpan(events, "eve.turn");
    const steps = findChildSpans(events, "eve.step", root?.span.id).sort(
      (left, right) =>
        Number(left.metadata?.["eve.step.index"]) -
        Number(right.metadata?.["eve.step.index"]),
    );
    const search = findLatestChildSpan(events, "search", root?.span.id);
    const read = findLatestChildSpan(events, "read", root?.span.id);

    expect(root).toBeDefined();
    expect(root?.span.type).toBe("task");
    expect(root?.metadata).toMatchObject({
      "eve.agent.name": "eve-instrumentation-scenario",
      "eve.channel.kind": "http",
      "eve.model.id": expect.any(String),
      model: "gpt-5.4-mini",
      provider: "openai",
    });
    expect(root?.metrics?.completion_tokens).toEqual(expect.any(Number));
    expect(root?.metrics?.prompt_tokens).toEqual(expect.any(Number));
    expect(root?.metrics?.tokens).toEqual(expect.any(Number));
    expect(root?.output).toContain("Final answer from read");

    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.span.type)).toEqual(["llm", "llm", "llm"]);
    for (const step of steps) {
      expect(step.span.parentIds).toEqual([root?.span.id]);
      expect(step.input).toEqual(expect.arrayContaining([expect.anything()]));
      expect(step.metadata).toMatchObject({
        "eve.model.id": expect.any(String),
        model: "gpt-5.4-mini",
        provider: "openai",
      });
    }

    expect(search).toBeDefined();
    expect(search?.span.type).toBe("tool");
    expect(search?.span.parentIds).toEqual([root?.span.id]);
    expect(search?.input).toMatchObject({
      query: expect.stringContaining("Braintrust Eve instrumentation"),
    });
    expect(search?.output).toMatchObject({
      title: "Eve instrumentation",
    });

    expect(read).toBeDefined();
    expect(read?.span.type).toBe("tool");
    expect(read?.span.parentIds).toEqual([root?.span.id]);
    expect(read?.input).toMatchObject({
      url: "https://eve.dev/docs/guides/instrumentation",
    });
    expect(read?.output).toMatchObject({
      section: "Runtime context",
      title: "Eve instrumentation",
    });

    await matchSpanTreeSnapshot(events, spanTreeSnapshotPath, {
      normalize: {
        additionalProviderIdKeys: [
          "eve.session.id",
          "eve.tool.call_id",
          "eve.turn.id",
        ],
      },
    });
  });
});
