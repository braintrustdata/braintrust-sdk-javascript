import { expect, test } from "vitest";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
const ROOT_NAME = "ai-sdk-concurrent-shared-model-root";
const MARKERS = ["MARKER_A", "MARKER_B"] as const;
const spanSnapshotPath = resolveFileSnapshotPath(
  import.meta.url,
  "concurrent-shared-model.span-tree.json",
);

function stringified(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function markerFrom(value: unknown): string | undefined {
  const text = stringified(value);
  return MARKERS.find((marker) => text.includes(marker));
}

function summarizedEntry(event: CapturedLogEvent) {
  const marker = markerFrom(event.input) ?? markerFrom(event.output);
  const fields =
    marker === undefined
      ? { metadata: { scenario: event.metadata?.scenario } }
      : {
          input: { marker },
          output: markerFrom(event.output)
            ? { marker: markerFrom(event.output) }
            : undefined,
        };

  return { event, fields };
}

test("wrapAISDK keeps doGenerate spans under each concurrent generateText parent when sharing a model", async () => {
  await withScenarioHarness(async (harness) => {
    await harness.runScenarioDir({
      entry: "scenario.concurrent-shared-model.ts",
      scenarioDir,
      timeoutMs: 30_000,
    });

    const events = harness.events();
    const root = findLatestSpan(events, ROOT_NAME);
    expect(root).toBeDefined();

    const parents = findChildSpans(events, "generateText", root?.span.id);
    expect(parents).toHaveLength(MARKERS.length);
    const children = parents.flatMap((parent) =>
      findChildSpans(events, "doGenerate", parent.span.id),
    );

    await matchSpanTreeSnapshot(
      [root, ...parents, ...children].map(summarizedEntry),
      spanSnapshotPath,
    );

    for (const marker of MARKERS) {
      const parent = parents.find((event) =>
        stringified(event.input).includes(marker),
      );
      expect(parent, `missing generateText parent for ${marker}`).toBeDefined();

      const markerChildren = findChildSpans(
        events,
        "doGenerate",
        parent?.span.id,
      );
      expect(markerChildren, `doGenerate children for ${marker}`).toHaveLength(
        1,
      );
      expect(stringified(markerChildren[0]?.input)).toContain(marker);
    }
  });
}, 30_000);
