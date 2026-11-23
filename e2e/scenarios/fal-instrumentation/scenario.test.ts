import { describe, expect, test } from "vite-plus/test";
import {
  effectiveScenarioTimeoutMs,
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import {
  findLatestSpan,
  findLatestChildSpan,
} from "../../helpers/trace-selectors";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
for (const variant of ["fal-v1", "fal-v1-latest"]) {
  describe(variant, { concurrent: false }, () => {
    for (const mode of ["wrapped", "auto", "wrapped-auto"]) {
      test(
        mode,
        async () => {
          await withScenarioHarness(async (harness) => {
            await harness.runNodeScenarioDir({
              scenarioDir,
              entry: "scenario.mjs",
              timeoutMs: 180_000,
              nodeArgs: mode.includes("auto")
                ? ["--import", "braintrust/hook.mjs"]
                : [],
              env: {
                FAL_PACKAGE_NAME: variant.replace("fal-", "fal-sdk-"),
                FAL_WRAP: mode.includes("wrapped") ? "1" : "0",
                BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS: "true",
                BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS: "false",
                BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS: "false",
              },
              runContext: { variantKey: variant, originalScenarioDir },
            });
            const events = harness.events();
            expect(
              findLatestSpan(events, "fal-instrumentation-root"),
            ).toBeDefined();
            for (const [operation, method] of [
              ["image", "run"],
              ["audio", "run"],
              ["video", "run"],
              ["stream-iterator", "stream"],
              ["stream-done", "stream"],
              ["stream-events", "stream"],
              ["error", "run"],
            ]) {
              const parent = findLatestSpan(events, operation);
              const span = findLatestChildSpan(
                events,
                `fal.${method}`,
                parent?.span.id,
              );
              expect(span?.span.type).toBe("llm");
              expect(span?.row.metadata).toMatchObject({
                provider: "fal",
                model: expect.any(String),
              });
              if (operation === "error") expect(span?.row.error).toBeTruthy();
              else {
                expect(span?.row.metadata).toMatchObject({
                  request_id: expect.any(String),
                });
                expect(span?.output).toBeTruthy();
              }
            }
            expect(
              new Set(
                events
                  .filter((event) => event.span.type === "llm")
                  .map((event) => event.span.id),
              ).size,
            ).toBe(7);
            const video = findLatestChildSpan(
              events,
              "fal.run",
              findLatestSpan(events, "video")?.span.id,
            );
            expect(video?.input).toMatchObject({
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: {
                      type: "braintrust_attachment",
                      content_type: "image/png",
                    },
                  },
                },
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
                `${variant}.span-tree.json`,
              ),
              { normalize: { additionalProviderIdKeys: ["request_id"] } },
            );
          });
        },
        effectiveScenarioTimeoutMs(240_000),
      );
    }
  });
}
