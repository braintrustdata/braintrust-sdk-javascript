import { beforeAll, describe, expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import { withScenarioHarness } from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot } from "../../helpers/span-tree";
import {
  findAllSpans,
  findChildSpans,
  findLatestSpan,
} from "../../helpers/trace-selectors";

const ROOT_NAME = "anthropic-vertex-instrumentation-root";

export function defineAnthropicVertexInstrumentationAssertions(options: {
  name: string;
  runScenario: Parameters<typeof withScenarioHarness>[0];
  snapshotName: string;
  testFileUrl: string;
  timeoutMs: number;
}): void {
  describe(options.name, () => {
    let events: CapturedLogEvent[] = [];
    beforeAll(async () => {
      await withScenarioHarness(async (harness) => {
        await options.runScenario(harness);
        events = harness.events();
      });
    }, options.timeoutMs);

    test("captures one Anthropic span per Vertex call", () => {
      const root = findLatestSpan(events, ROOT_NAME);
      expect(root).toBeDefined();
      const llmSpans = findAllSpans(events, "anthropic.messages.create");
      expect(llmSpans).toHaveLength(6);
      for (const beta of [false, true]) {
        for (const operation of ["create", "stream", "stream-helper"]) {
          const parent = findLatestSpan(
            events,
            `anthropic-vertex-${beta ? "beta-" : ""}${operation}-operation`,
          );
          expect(parent?.span.parentIds).toEqual([root?.span.id]);
          const spans = findChildSpans(
            events,
            "anthropic.messages.create",
            parent?.span.id,
          );
          expect(spans).toHaveLength(1);
          const span = spans[0]!;
          expect(span.row.metadata).toMatchObject({
            provider: "anthropic",
            model: expect.any(String),
          });
          expect(span.input).toBeDefined();
          expect(span.output).toBeDefined();
          expect(span.metrics).toMatchObject({
            prompt_tokens: expect.any(Number),
            completion_tokens: expect.any(Number),
          });
          if (operation !== "create") {
            expect(span.metrics?.time_to_first_token).toEqual(
              expect.any(Number),
            );
          }
          expect(span.row.error).toBeUndefined();
        }
      }
    });

    test("matches span tree snapshot", async () => {
      await matchSpanTreeSnapshot(
        events,
        resolveFileSnapshotPath(
          options.testFileUrl,
          `${options.snapshotName}.span-tree.json`,
        ),
      );
    });
  });
}
