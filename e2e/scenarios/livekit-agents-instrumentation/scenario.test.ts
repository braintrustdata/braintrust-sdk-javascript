import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { braintrustEsbuildPlugin } from "braintrust/esbuild";
import { describe, expect, test } from "vitest";
import { startInferenceCassette } from "./inference-cassette.mjs";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import {
  findLatestSpan,
  findLatestChildSpan,
  findAllSpans,
} from "../../helpers/trace-selectors";
import {
  formatSpanTreeJsonSnapshot,
  matchSpanTreeSnapshot,
  spanTreeFields,
  type SpanTreeEntry,
} from "../../helpers/span-tree";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";

const originalScenarioDir = resolveScenarioDir(import.meta.url);
// Provider plugins peer-depend on the exact core version. Isolate each install
// so instanceof checks use the same LiveKit classes as the provider plugin.
const scenarios = [];
for (const variant of ["livekit-v1-5", "livekit-v1-9", "livekit-v1-latest"]) {
  const source = path.resolve(
    originalScenarioDir,
    "../../.bt-tmp/generated-scenarios",
    variant,
  );
  await fs.mkdir(source, { recursive: true });
  await fs.cp(path.join(originalScenarioDir, "versions", variant), source, {
    recursive: true,
  });
  for (const file of ["scenario.mjs", "capture-outcome.mjs"]) {
    await fs.copyFile(
      path.join(originalScenarioDir, file),
      path.join(source, file),
    );
  }
  await fs.copyFile(
    path.resolve(
      originalScenarioDir,
      "../google-genai-instrumentation/test-image.png",
    ),
    path.join(source, "test-image.png"),
  );
  scenarios.push({
    variant,
    scenarioDir: await prepareScenarioDir({ scenarioDir: source }),
  });
}

for (const { variant, scenarioDir } of scenarios) {
  describe.sequential(variant, () => {
    test("bundler transforms the installed public nodes and tool factory", async () => {
      const require = createRequire(path.join(scenarioDir, "package.json"));
      const sdkRequire = createRequire(require.resolve("braintrust"));
      const { build } = sdkRequire("esbuild");
      const packageDir = path.resolve(
        path.dirname(require.resolve("@livekit/agents")),
        "..",
      );
      for (const extension of ["js", "cjs"]) {
        const result = await build({
          entryPoints: [
            path.join(packageDir, `dist/voice/agent.${extension}`),
            path.join(packageDir, `dist/llm/tool_context.${extension}`),
          ],
          outdir: "/tmp/livekit-esbuild-unused",
          write: false,
          bundle: false,
          platform: "node",
          format: extension === "cjs" ? "cjs" : "esm",
          plugins: [braintrustEsbuildPlugin()],
        });
        const code = result.outputFiles
          .map((file: { text: string }) => file.text)
          .join("\n");
        for (const name of [
          "Agent.llmNode",
          "Agent.sttNode",
          "Agent.ttsNode",
          "Agent.default.llmNode",
          "Agent.default.sttNode",
          "Agent.default.ttsNode",
          "llm.tool",
        ]) {
          expect(code).toContain(`@livekit/agents:${name}`);
        }
      }
    });
    test(
      "pipeline contract across instrumentation modes",
      async () => {
        const cases = new Map<
          string,
          { entries: SpanTreeEntry[]; json: string }
        >();
        const snapshotOptions = {
          normalize: { additionalProviderIdKeys: ["speech_id"] },
        };
        for (const mode of [
          "wrapped",
          "auto",
          "wrapped-auto",
          "auto-cjs",
          "wrapped-no-attachments",
          "inference-wrapped",
          "inference-auto",
          "inference-wrapped-auto",
        ]) {
          const inference = mode.startsWith("inference-");
          const variantKey = `${variant}${inference ? "-inference" : ""}`;
          const capture = !mode.includes("no-attachments");
          await withScenarioHarness(async (harness) => {
            const speech = inference
              ? await startInferenceCassette(
                  scenarioDir,
                  path.join(
                    originalScenarioDir,
                    "__cassettes__",
                    `${variantKey}.websocket.json`,
                  ),
                  process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record",
                )
              : undefined;
            try {
              await harness.runNodeScenarioDir({
                scenarioDir,
                entry: "scenario.mjs",
                timeoutMs: 180_000,
                nodeArgs: mode.includes("auto")
                  ? ["--import", "braintrust/hook.mjs"]
                  : [],
                env: {
                  ...(speech
                    ? {
                        LIVEKIT_INFERENCE: "1",
                        LIVEKIT_SPEECH_BASE_URL: speech.url,
                      }
                    : {}),
                  LIVEKIT_WRAP: mode.includes("wrapped") ? "1" : "0",
                  LIVEKIT_CJS: mode.includes("cjs") ? "1" : "0",
                  BRAINTRUST_CAPTURE_ATTACHMENTS: capture ? "true" : "false",
                },
                runContext: { variantKey, originalScenarioDir },
              });
            } finally {
              await speech?.stop();
            }
            const events = harness.events();
            const root = findLatestSpan(events, "livekit-session");
            expect(root).toBeDefined();
            const session = findLatestChildSpan(
              events,
              "livekit.session",
              root?.span.id,
            )!;
            expect(session?.row.metadata).toMatchObject({
              session_id: "capture-session",
              status: "completed",
            });
            expect(session?.metrics?.end).toBeDefined();
            const turns = findAllSpans(events, "livekit.turn");
            expect(turns).toHaveLength(inference ? 2 : 1);
            for (const turn of turns) {
              expect(turn.row.span_parents).toEqual([session.span.id]);
              expect(turn.row.root_span_id).toBe(root?.row.root_span_id);
              expect(turn.metadata?.status).toBe("completed");
              expect(turn.metrics?.end).toBeDefined();
              expect(turn.output).toEqual(expect.any(Array));
            }
            const runTurn = turns.find(
              (event) => event.metadata?.operation === "run",
            )!;
            expect(runTurn.input).toEqual([
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Use lookup_weather to check the weather in Paris.",
                  },
                ],
              },
            ]);
            expect(
              findLatestChildSpan(
                events,
                "livekit.Agent.llmNode",
                runTurn.span.id,
              ),
            ).toBeDefined();
            if (inference)
              expect(
                turns.find((event) => event.metadata?.operation === "voice")
                  ?.input,
              ).toEqual([
                {
                  role: "user",
                  content: [
                    { type: "text", text: expect.stringMatching(/\S/) },
                  ],
                },
              ]);
            const tool = findLatestSpan(events, "lookup_weather");
            expect(tool?.span.type).toBe("tool");
            expect(tool?.row.span_parents).toEqual([runTurn.span.id]);
            expect(tool?.output).toMatchObject({
              weather: "sunny",
              temperature: 20,
            });
            for (const [name, parent] of [
              ["llmNode", "vision"],
              ["ttsNode", "speech"],
              ["sttNode", "transcription"],
            ]) {
              const span = findLatestChildSpan(
                events,
                `livekit.Agent.${name}`,
                findLatestSpan(events, parent)?.span.id,
              );
              expect(span?.span.type).toBe("llm");
              expect(span?.row.metadata).toMatchObject({
                provider: inference ? "livekit" : "openai",
              });
              expect(span?.metrics?.time_to_first_token).toBeGreaterThanOrEqual(
                0,
              );
              expect(span?.metrics?.end).toBeDefined();
            }
            const stt = findLatestChildSpan(
              events,
              "livekit.Agent.sttNode",
              findLatestSpan(events, "transcription")?.span.id,
            )!;
            expect(stt.output).toMatchObject({
              content: [{ type: "text", text: expect.stringMatching(/\S/) }],
            });
            const tts = findLatestSpan(events, "livekit.Agent.ttsNode")!;
            for (const value of [stt.input, tts.output]) {
              expect(value).toMatchObject({
                content: capture
                  ? [
                      expect.objectContaining({
                        type: "file",
                        file: expect.objectContaining({
                          file_data: expect.objectContaining({
                            type: "braintrust_attachment",
                            content_type: "audio/wav",
                          }),
                        }),
                      }),
                    ]
                  : [],
              });
            }
            // The session parent is explicit; no session lifecycle or duplicate
            // underlying OpenAI model spans should be introduced.
            expect(
              events.some(
                (event) =>
                  (event.span.type === "llm" &&
                    !event.span.name?.startsWith("livekit.Agent.")) ||
                  event.span.name?.startsWith("livekit.AgentSession"),
              ),
            ).toBe(false);
            const caseName = inference
              ? "LiveKit Inference"
              : capture
                ? "OpenAI plugin"
                : "Attachments disabled";
            const entries = events.map((event) => ({
              event,
              // Label snapshot roots without changing the actual captured spans.
              name:
                event.span.id === root?.span.id
                  ? `${caseName}: ${event.span.name}`
                  : undefined,
              fields: {
                ...spanTreeFields(event),
                context: event.row.context,
              },
            }));
            const json = formatSpanTreeJsonSnapshot(entries, snapshotOptions);
            const previous = cases.get(caseName);
            if (previous) {
              // All modes assert the same complete payload, even when updating
              // snapshots. Keep each case only once in the combined file.
              expect(json, `${variant}: ${mode}`).toBe(previous.json);
            } else {
              cases.set(caseName, { entries, json });
            }
          });
        }
        await matchSpanTreeSnapshot(
          [
            "OpenAI plugin",
            "LiveKit Inference",
            "Attachments disabled",
          ].flatMap((name) => cases.get(name)!.entries),
          resolveFileSnapshotPath(import.meta.url, `${variant}.span-tree.json`),
          snapshotOptions,
        );
      },
      240_000 * 8,
    );
  });
}
