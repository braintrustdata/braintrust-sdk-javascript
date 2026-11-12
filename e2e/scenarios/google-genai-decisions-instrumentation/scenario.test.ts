import { describe, expect, test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { findAllSpans, findLatestSpan } from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

for (const variant of ["v3", "v3-latest"]) {
  describe.sequential(variant, () => {
    for (const mode of ["wrapped", "auto-esm", "auto-cjs"]) {
      test(
        mode,
        async () => {
          await withScenarioHarness(async (harness) => {
            await harness.runNodeScenarioDir({
              scenarioDir,
              entry: "scenario.mjs",
              env: {
                GOOGLE_GENAI_PACKAGE_NAME: `google-genai-sdk-${variant}`,
                GOOGLE_GENAI_MODE: mode,
                BRAINTRUST_CAPTURE_ATTACHMENTS: "false",
              },
              nodeArgs:
                mode === "wrapped" ? [] : ["--import", "braintrust/hook.mjs"],
              runContext: {
                variantKey: `google-genai-decisions-${variant}`,
                originalScenarioDir,
              },
            });
            const events = harness.events();
            const root = findLatestSpan(events, "google-genai-decisions-root");
            const decisions = findAllSpans(events, "create_decision");
            expect(decisions).toHaveLength(2);
            for (const span of decisions) {
              expect(span.span.type).toBe("decision");
              expect(span.span.parentIds).toEqual([root!.span.id]);
              expect(span.row.metadata).toMatchObject({
                model: "gemini-decision-1",
                provider: "google",
              });
              expect(span.metrics).toMatchObject({
                prompt_tokens: expect.any(Number),
                tokens: expect.any(Number),
              });
            }
            const text = decisions.find(
              (event) => typeof (event.input as any)?.state === "string",
            )!;
            expect(text.output).toMatchObject({
              answers: [
                {
                  id: "resolved",
                  type: "boolean",
                  probability: expect.any(Number),
                },
                {
                  id: "sentiment",
                  type: "choice",
                  choice: expect.any(String),
                  probabilities: expect.any(Object),
                },
                {
                  id: "urgency",
                  type: "score",
                  score: expect.any(Number),
                  legend: expect.any(Object),
                },
              ],
            });
            const media = decisions.find((event) =>
              Array.isArray((event.input as any)?.state),
            )!;
            expect(media.input).toMatchObject({
              state: [
                { type: "image", mime_type: "image/png", data: "<omitted>" },
              ],
            });
            await matchSpanTreeSnapshot(
              events.map((event) => ({
                event,
                fields: {
                  ...spanTreeFields(event),
                  context: event.row.context,
                },
              })),
              resolveFileSnapshotPath(
                import.meta.url,
                `google-genai-decisions-${variant}-${mode}.span-tree.json`,
              ),
            );
          });
        },
        180_000,
      );
    }
  });
}
