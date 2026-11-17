import { describe, expect, test } from "vite-plus/test";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import {
  prepareScenarioDir,
  readInstalledPackageVersion,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { matchSpanTreeSnapshot, spanTreeFields } from "../../helpers/span-tree";
import { findAllSpans } from "../../helpers/trace-selectors";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});

for (const major of [4, 5, 6, 7]) {
  for (const suffix of ["", "-latest"]) {
    const variantKey = `ai-sdk-v${major}${suffix}`;
    const version = await readInstalledPackageVersion(scenarioDir, variantKey);
    describe(
      `AI SDK audio ${version} (${variantKey})`,
      { concurrent: false },
      () => {
        const modes = ["wrapped", "auto-hook", "wrapped-auto"];
        // v4–v6 ship separate CommonJS builds; v7 is ESM-only.
        if (major < 7)
          modes.push("wrapped-cjs", "auto-hook-cjs", "wrapped-auto-cjs");
        for (const mode of modes) {
          test(mode, { timeout: 180_000 }, async () => {
            await withScenarioHarness(async (harness) => {
              await harness.runNodeScenarioDir({
                scenarioDir,
                entry: "scenario.mjs",
                nodeArgs:
                  mode === "wrapped" || mode === "wrapped-cjs"
                    ? []
                    : ["--import", "braintrust/hook.mjs"],
                env: {
                  BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS: "true",
                  AI_SDK_PACKAGE_NAME: variantKey,
                  AI_SDK_OPENAI_PACKAGE_NAME: `ai-sdk-openai-v${major}${suffix}`,
                  AI_SDK_AUDIO_MODE: mode,
                },
                runContext: { variantKey, originalScenarioDir },
                timeoutMs: 180_000,
              });
              const events = harness.events();
              const roots = findAllSpans(events, "ai-sdk-audio");
              expect(roots).toHaveLength(1);
              const speech = findAllSpans(events, "generateSpeech");
              const transcriptions = findAllSpans(events, "transcribe");
              expect(speech).toHaveLength(2);
              expect(transcriptions).toHaveLength(2);
              for (const span of [...speech, ...transcriptions]) {
                expect(span.span.parentIds).toEqual([roots[0].span.id]);
                expect(span.span.ended).toBe(true);
                expect(span.span.type).toBe("llm");
                expect(span.row.error).toBeUndefined();
                expect(span.metrics?.start).toEqual(expect.any(Number));
                expect(span.metrics?.end).toEqual(expect.any(Number));
              }
              expect(speech[0].input).toMatchObject({
                operation: "speech",
                prompt: "Hello. This is a short audio test.",
                parameters: { voice: "alloy" },
              });
              expect(speech[0].metadata).toMatchObject({
                model: "gpt-4o-mini-tts",
                provider: "openai",
              });
              expect(speech[0].output).toMatchObject({
                content: [
                  {
                    type: "file",
                    file: {
                      filename: major === 4 ? "audio.wav" : "audio.mp3",
                      file_data: "<omitted>",
                    },
                  },
                ],
              });
              expect(speech[1].output).toMatchObject({
                content: [
                  { file: { file_data: { type: "braintrust_attachment" } } },
                ],
              });
              expect(transcriptions[0].input).toMatchObject({
                content: [{ file: { file_data: "<omitted>" } }],
              });
              expect(transcriptions[1].input).toMatchObject({
                content: [
                  { file: { file_data: { type: "braintrust_attachment" } } },
                ],
              });
              for (const span of transcriptions) {
                expect(span.output).toMatchObject({
                  content: [
                    { type: "text", text: expect.stringMatching(/hello/i) },
                  ],
                  annotations: { segments: expect.any(Array) },
                });
                expect(span.metadata).toMatchObject({
                  model: "gpt-4o-mini-transcribe",
                  provider: "openai",
                });
              }
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
                  `${variantKey}.span-tree.json`,
                ),
              );
            });
          });
        }
      },
    );
  }
}
