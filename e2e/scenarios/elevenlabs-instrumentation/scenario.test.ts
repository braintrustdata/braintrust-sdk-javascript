import { describe, expect, test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import {
  findLatestSpan,
  findLatestChildSpan,
} from "../../helpers/trace-selectors";
import { spanTreeFields, matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
for (const variant of ["elevenlabs-v2", "elevenlabs-v2-latest"]) {
  describe.sequential(variant, () => {
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
                ELEVENLABS_PACKAGE_NAME: variant.replace(
                  "elevenlabs-",
                  "elevenlabs-sdk-",
                ),
                ELEVENLABS_WRAP: mode.includes("wrapped") ? "1" : "0",
              },
              runContext: { variantKey: variant, originalScenarioDir },
            });
            const events = harness.events();
            const root = findLatestSpan(
              events,
              "elevenlabs-instrumentation-root",
            );
            expect(root).toBeDefined();
            for (const [operation, method] of [
              ["speech", "convert"],
              ["stream", "stream"],
              ["timestamps", "convertWithTimestamps"],
              ["stream-timestamps", "streamWithTimestamps"],
              ["error", "convert"],
            ]) {
              const parent = findLatestSpan(events, operation);
              const span = findLatestChildSpan(
                events,
                `elevenlabs.textToSpeech.${method}`,
                parent?.span.id,
              );
              expect(span).toBeDefined();
              expect(span?.span.type).toBe("llm");
              expect(span?.row.metadata).toMatchObject({
                provider: "elevenlabs",
              });
              if (operation === "error") expect(span?.row.error).toBeTruthy();
              else {
                expect(span?.output).toMatchObject({
                  content: [
                    {
                      type: "file",
                      file: {
                        file_data: {
                          type: "braintrust_attachment",
                          content_type: "audio/mpeg",
                        },
                      },
                    },
                  ],
                });
                if (operation.startsWith("stream"))
                  expect(
                    span?.metrics.time_to_first_token,
                  ).toBeGreaterThanOrEqual(0);
              }
            }
            const transcription = findLatestSpan(
              events,
              "elevenlabs.speechToText.convert",
            );
            expect(transcription?.input).toMatchObject({
              operation: "transcribe",
              content: [
                {
                  type: "file",
                  file: {
                    filename: "speech.mp3",
                    file_data: { type: "braintrust_attachment" },
                  },
                },
              ],
            });
            expect(transcription?.output).toMatchObject({
              content: [
                { type: "text", text: expect.stringMatching(/hello/i) },
              ],
            });
            expect(
              new Set(
                events
                  .filter((event) => event.span.type === "llm")
                  .map((event) => event.span.id),
              ),
            ).toHaveProperty("size", 6);
            const untraced = findLatestSpan(events, "untraced-apis");
            expect(untraced).toBeDefined();
            expect(
              events.filter((event) =>
                event.span.parentIds.includes(untraced!.span.id),
              ),
            ).toEqual([]);
            expect(
              events.some((event) =>
                event.span.name?.startsWith("elevenlabs.speechEngine"),
              ),
            ).toBe(false);
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
            );
          });
        },
        240_000,
      );
    }
  });
}
