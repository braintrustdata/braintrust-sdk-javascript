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
for (const version of [
  "v3",
  "v3-latest",
  "v4",
  "v4-latest",
  "v5",
  "v5-latest",
]) {
  const variant = `deepgram-${version}`;
  const modern = version.startsWith("v5");
  describe.sequential(variant, () => {
    for (const mode of ["wrapped", "auto", "wrapped-auto"])
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
                DEEPGRAM_PACKAGE_NAME: `deepgram-sdk-${version}`,
                DEEPGRAM_WRAP: mode.includes("wrapped") ? "1" : "0",
                BRAINTRUST_CAPTURE_ATTACHMENTS: "true",
                BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS: "true",
                BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS: "true",
              },
              runContext: { variantKey: variant, originalScenarioDir },
            });
            const events = harness.events();
            expect(
              findLatestSpan(events, "deepgram-instrumentation-root"),
            ).toBeDefined();
            const listen = modern ? "listen.v1.media" : "listen.prerecorded";
            const speech = modern ? "speak.v1.audio.generate" : "speak.request";
            const operations = [
              ["transcribe-buffer", `${listen}.transcribeFile`],
              ["transcribe-stream", `${listen}.transcribeFile`],
              ["transcribe-url", `${listen}.transcribeUrl`],
              ["speech-stream", speech],
              ...(modern
                ? [
                    ["speech-arrayBuffer", speech],
                    ["speech-blob", speech],
                  ]
                : []),
              ...(version === "v5-latest"
                ? [["speech-v2", "speak.v2.audio.generate"]]
                : []),
              [
                "analyze-text",
                modern ? "read.v1.text.analyze" : "read.analyzeText",
              ],
              [
                "analyze-url",
                modern ? "read.v1.text.analyze" : "read.analyzeUrl",
              ],
              ["error", `${listen}.transcribeUrl`],
            ];
            for (const [operation, method] of operations) {
              const parent = findLatestSpan(events, operation);
              const span = findLatestChildSpan(
                events,
                `deepgram.${method}`,
                parent?.span.id,
              );
              expect(span).toBeDefined();
              expect(span?.span.type).toBe("llm");
              expect(span?.row.metadata).toMatchObject({
                provider: "deepgram",
              });
              if (operation === "error") expect(span?.row.error).toBeTruthy();
              else if (operation.startsWith("speech"))
                expect(span?.output).toMatchObject({
                  content: [
                    {
                      type: "file",
                      file: {
                        file_data: {
                          type: "braintrust_attachment",
                          content_type: "audio/wav",
                        },
                      },
                    },
                  ],
                });
              else if (operation.startsWith("transcribe")) {
                expect(span?.output).toMatchObject({
                  content: [{ type: "text", text: expect.any(String) }],
                });
                if (operation !== "transcribe-url")
                  expect(span?.input).toMatchObject({
                    content: [
                      {
                        type: "file",
                        file: { file_data: { type: "braintrust_attachment" } },
                      },
                    ],
                  });
              } else
                expect(span?.output).toHaveProperty("annotations.sentiments");
            }
            expect(
              new Set(
                events
                  .filter((event) => event.span.type === "llm")
                  .map((event) => event.span.id),
              ).size,
            ).toBe(operations.length);
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
  });
}
