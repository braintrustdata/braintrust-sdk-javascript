import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { assertAudioTrace, audioSession, selectionsOf } from "./assertions";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { findLatestSpan, findAllSpans } from "../../helpers/trace-selectors";
import { spanTreeFields, matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";

// LiveKit timings and native IDs vary per run; the shared normalizer covers the rest.
const VOLATILE_NUMBER =
  /(_ms|_at|_delay|At|e2e_latency|wait_duration|queue_wait|playback_latency|playbackPosition|ttft|ttfb|time_to_first_chunk|time_to_first_token|timestamp|ttfbMs|durationMs|tokensPerSecond)$/;
const NATIVE_ID = /^(item_|speech_)|^[0-9a-f]{8}-[0-9a-f]{3}$/;
function normalizer() {
  const ids = new Map<string, string>();
  const native = (value: string) => {
    if (!ids.has(value)) ids.set(value, `<native:${ids.size + 1}>`);
    return ids.get(value)!;
  };
  function stable(value: unknown, key = ""): unknown {
    if (typeof value === "number" && VOLATILE_NUMBER.test(key)) return 0;
    if (typeof value === "string" && /(_metrics|\.stt\.events)$/.test(key)) {
      try {
        return stable(JSON.parse(value));
      } catch {}
    }
    if (typeof value === "string" && NATIVE_ID.test(value))
      return native(value);
    if (typeof value === "string" && /^127\.0\.0\.1:\d+$/.test(value))
      return "<provider-host>";
    if (Array.isArray(value)) return value.map((v) => stable(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          NATIVE_ID.test(k) ? native(k) : k,
          stable(v, k),
        ]),
      );
    return value;
  }
  return stable;
}

const originalScenarioDir = resolveScenarioDir(import.meta.url);
const variants = ["livekit-v1", "livekit-v1-latest"];
// Plugins pin an exact @livekit/agents peer, so aliases in one install root would
// share a single peer copy. Generate one install root per version instead.
const scenarioDirs = Object.fromEntries(
  await Promise.all(
    variants.map(async (variant) => {
      const sourceDir = path.resolve(
        originalScenarioDir,
        `../../.bt-tmp/generated-scenarios/livekit-instrumentation-${variant}`,
      );
      await fs.rm(sourceDir, { force: true, recursive: true });
      await fs.cp(originalScenarioDir, sourceDir, {
        recursive: true,
        filter: (source) =>
          ![
            "node_modules",
            "versions",
            "__cassettes__",
            "__snapshots__",
          ].includes(path.basename(source)),
      });
      await fs.cp(
        path.join(originalScenarioDir, "versions", variant),
        sourceDir,
        { recursive: true },
      );
      return [variant, await prepareScenarioDir({ scenarioDir: sourceDir })];
    }),
  ),
);

type RunOptions = {
  mode?: "auto" | "wrapped" | "wrapped-auto";
  entry?: string;
  env?: Record<string, string>;
  cassette?: string;
  recording?: boolean;
};
/** The span IDs a span links to with this relationship, in order. */
function linkTargets(span: CapturedLogEvent | undefined, type: string) {
  return (
    (span?.metadata?.links ?? []) as {
      context: { spanId: string };
      attributes: Record<string, string>;
    }[]
  )
    .filter((l) => l.attributes["braintrust.relationship.type"] === type)
    .map((l) => l.context.spanId);
}
/** The span IDs a model response's context links to, in order. */
const contextLinks = (span: CapturedLogEvent | undefined) =>
  linkTargets(span, "uses_context");

/** What the scenario reported about each uploaded audio file, in order. */
function uploadedAudio(
  stdout: string,
): { format: string; decodedMs?: number }[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith('{"uploadedAudio":'))
    .map((line) => JSON.parse(line).uploadedAudio);
}

function scenarioOptions(
  variant: string,
  {
    mode = "auto",
    entry = "scenario.mjs",
    env = {},
    cassette,
    recording = true,
  }: RunOptions,
) {
  const scenarioDir = scenarioDirs[variant];
  return {
    scenarioDir,
    entry,
    timeoutMs: 90000,
    nodeArgs:
      mode === "wrapped"
        ? []
        : [
            "--import",
            `${scenarioDir}/configure.mjs`,
            "--import",
            "braintrust/hook.mjs",
          ],
    env: {
      LIVEKIT_WRAP: mode === "auto" ? "0" : "1",
      // Combined mode exercises both LiveKit paths; OpenAI uses the auto hook.
      LIVEKIT_WRAP_PROVIDER: mode === "wrapped" ? "1" : "0",
      BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS: recording ? "true" : "",
      BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS: recording ? "true" : "",
      BRAINTRUST_DISABLE_INSTRUMENTATION: "",
      ...(cassette ? { LIVEKIT_PROVIDER: "1" } : {}),
      ...env,
    },
    runContext: {
      variantKey: variant,
      originalScenarioDir,
      cassette: cassette ? { variantKey: `${variant}-${cassette}` } : false,
    },
  };
}

async function snapshotTrace(events: CapturedLogEvent[], name: string) {
  const stable = normalizer();
  await matchSpanTreeSnapshot(
    events.map((event) => ({
      event,
      fields: stable({
        ...spanTreeFields(event),
        context: event.row.context,
      }) as Record<string, unknown>,
    })),
    resolveFileSnapshotPath(import.meta.url, `${name}.span-tree.json`),
  );
}

for (const variant of variants) {
  for (const mode of ["auto", "wrapped"] as const) {
    for (const client of ["sdk", "custom"] as const) {
      for (const enabled of [true, false]) {
        test(`${variant} ${mode} public constructors classify ${client} client with provider ${enabled ? "on" : "off"}`, async () => {
          await withScenarioHarness(async (harness) => {
            await harness.runNodeScenarioDir(
              scenarioOptions(variant, {
                mode,
                entry: "framework-regression.mjs",
                recording: false,
                env: {
                  LIVEKIT_PROBE: "ownership",
                  LIVEKIT_PROBE_CLIENT: client,
                  LIVEKIT_OPENAI_INTEGRATION: enabled ? "on" : "off",
                },
              }),
            );
            const events = harness.events();
            const names =
              client === "custom"
                ? ["livekit.llm_response", "livekit.stt", "livekit.tts"]
                : enabled
                  ? [
                      "Chat Completion",
                      "openai.audio.transcriptions.create",
                      "openai.audio.speech.create",
                    ]
                  : [];
            for (const [index, name] of names.entries()) {
              const model = findAllSpans(events, name);
              expect(model).toHaveLength(1);
              const wrapper = findLatestSpan(
                events,
                ["llm_response", "stt", "tts"][index],
              );
              expect(model[0].row.span_parents).toEqual([wrapper?.row.span_id]);
              expect(model[0].span.type).toBe("llm");
              expect(model[0].row.error).toBeTruthy();
            }
            if (client === "sdk")
              for (const name of [
                "livekit.llm_response",
                "livekit.stt",
                "livekit.tts",
              ])
                expect(findAllSpans(events, name)).toHaveLength(0);
            if (client === "sdk" && !enabled)
              expect(
                events.filter((event) => event.span.type === "llm"),
              ).toHaveLength(0);
          });
        }, 120000);
      }
    }
    test(`${variant} ${mode} preserves attempt-local buffered output and usage`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            mode,
            entry: "framework-regression.mjs",
            recording: false,
          }),
        );
        const models = findAllSpans(harness.events(), "livekit.llm_response");
        expect(models).toHaveLength(2);
        expect(
          models.map(
            (model) =>
              (model.output as { message: { content: string } }[])[0].message
                .content,
          ),
        ).toEqual(["FIRST", "SECOND"]);
        expect(models.map((model) => model.metrics?.tokens)).toEqual([5, 8]);
        expect(
          models.map((model) => model.metrics?.completion_reasoning_tokens),
        ).toEqual([1, 1]);
        expect(
          models.map((model) => model.metrics?.prompt_cached_tokens),
        ).toEqual([1, 2]);
        expect(
          models.map((model) => model.metrics?.prompt_cache_creation_tokens),
        ).toEqual([0, 0]);
        expect(
          models.map((model) => model.metadata?.served_service_tier),
        ).toEqual(["flex", "priority"]);
        expect(models[0].row.error).toContain("controlled retry");
        expect(models[1].row.error).toBeUndefined();
        const wrapper = findLatestSpan(harness.events(), "llm_response");
        expect(wrapper?.metrics?.tokens).toBeUndefined();
        for (const model of models) {
          expect(model.row.span_parents).toEqual([wrapper?.row.span_id]);
          expect(model.metrics?.time_to_first_token).toBeGreaterThanOrEqual(0);
        }
      });
    }, 120000);
  }
}

const spoken = (event: CapturedLogEvent | undefined, pattern: RegExp) =>
  expect(event?.row.output).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.stringMatching(pattern),
      }),
    ]),
  );

for (const variant of variants) {
  // Real installed framework classes with synthetic lifecycle events, not providers.
  for (const mode of ["auto", "wrapped", "wrapped-auto"] as const)
    test(`${variant} ${mode} transcription lifecycle`, async () => {
      await withScenarioHarness(async (harness) => {
        const result = await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            mode,
            entry: "lifecycle.mjs",
            recording: false,
          }),
        );
        const events = harness.events();
        const roots = findAllSpans(events, "session");
        expect(roots).toHaveLength(4);
        const probes = result.stdout
          .split("\n")
          .filter((line) => line.startsWith('{"probe":'))
          .map((line) => JSON.parse(line));
        for (const probe of probes) {
          const root = roots.find(
            (row) =>
              row.metadata?.["contrib.livekit.probe.case"] === probe.probe,
          )!;
          expect(root).toBeDefined();
          const turns = findAllSpans(events, "user_turn").filter(
            (row) => row.span.rootId === root.span.rootId,
          );
          expect(turns).toHaveLength(1);
          const waits = findAllSpans(events, "eou_wait")
            .filter((row) => row.span.rootId === root.span.rootId)
            .sort(
              (a, b) => Number(a.metrics?.start) - Number(b.metrics?.start),
            );
          expect(waits).toHaveLength(probe.start ? 1 : 2);
          expect(
            findAllSpans(events, "livekit.eou_wait")
              .filter((row) => row.span.rootId === root.span.rootId)
              // The selector filters by name before merging. An earlier flush
              // can retain the diagnostic name for the same subsequently
              // normalized row; count identities, not historical names.
              .filter(
                (row) => !waits.some((wait) => wait.span.id === row.span.id),
              )
              .map((row) => ({
                probe: probe.probe,
                metadata: row.metadata,
                metrics: row.metrics,
              })),
          ).toEqual([]);
          if (probe.start) {
            expect(waits[0].metrics?.start).toBe(probe.start);
            expect(waits[0].metadata?.["eou.outcome"]).toBe("committed");
            expect(waits[0].metadata).not.toHaveProperty(
              "eou.speech_end_source",
            );
          } else {
            expect(Number(waits[0].metrics?.start) - probe.base).toBeCloseTo(2);
            expect(Number(waits[0].metrics?.end) - probe.base).toBeCloseTo(2.3);
            expect(Number(waits[1].metrics?.start) - probe.base).toBeCloseTo(
              3.5,
            );
            if (!probe.probe.endsWith("shutdown"))
              expect(Number(waits[1].metrics?.end) - probe.base).toBeCloseTo(4);
            expect(waits[0].metadata?.["eou.outcome"]).toBe("user_resumed");
            expect(waits[0].metadata).not.toHaveProperty(
              "contrib.livekit.eou.native_start_unix_ms",
            );
            for (const row of waits)
              expect(row.metadata?.["eou.speech_end_source"]).toBe("vad");
            if (probe.probe.endsWith("shutdown")) {
              expect(waits[1].metadata).not.toHaveProperty("eou.outcome");
              expect(waits[1].metadata?.["contrib.livekit.incomplete"]).toBe(
                true,
              );
            } else
              expect(waits[1].metadata?.["eou.outcome"]).toBe(
                probe.probe.endsWith("drop") ? "dropped" : "committed",
              );
          }
          for (const row of waits) {
            expect(row.span.parentIds).toEqual([turns[0].span.id]);
            expect(row.metadata?.["turn.id"]).toBe(turns[0].span.id);
            expect(row.metadata?.["audio.source_id"]).toBe("session-input");
            expect(row.metadata).not.toHaveProperty("eou.end_reason");
            expect(row.metadata).not.toHaveProperty("eou.detection_methods");
            expect(row.metrics?.end).toEqual(expect.any(Number));
          }
        }
        expect(probes).toHaveLength(4);
      });
    }, 120000);

  // Fixture playback through each setup path, including idempotent double wrapping.
  for (const mode of ["auto", "wrapped", "wrapped-auto"] as const)
    test(`${variant} ${mode} fixture recording`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(scenarioOptions(variant, { mode }));
        const events = assertAudioTrace(harness.events());
        const root = findAllSpans(events, "session");
        expect(root).toHaveLength(1);
        const { session, segments } = audioSession(root[0]);
        expect(session?.sources).toEqual({
          "session-input": { label: "Agent input audio" },
          "agent-output": { label: "Agent audio" },
        });
        expect(segments).toMatchObject([
          {
            id: "part-0",
            state: "ready",
            start_offset_ms: 0,
            // Fixture playback has no caller input, so channel 0 names no source.
            channels: {
              "0": { sources: [] },
              "1": { sources: ["agent-output"] },
            },
          },
        ]);
        // The ready descriptor is only published after the upload completes.
        const requests = harness.requestsAfter(0);
        const uploaded = requests.findIndex(
          (r) =>
            r.path === "/attachment/status" &&
            (r.jsonBody as { status?: { upload_status?: string } })?.status
              ?.upload_status === "done",
        );
        const ready = requests.findIndex(
          (r) =>
            r.path === "/logs3" &&
            JSON.stringify(r.jsonBody).includes('"state":"ready"'),
        );
        expect(uploaded).toBeGreaterThanOrEqual(0);
        expect(ready).toBeGreaterThan(uploaded);
        await snapshotTrace(events, `${variant}-audio`);
      });
    }, 120000);

  // With @braintrust/audio installed, recordings upload as Ogg Opus.
  for (const [name, audio] of [
    ["by default", undefined],
    [
      "with configured options",
      { codec: { name: "opus", options: { bitrate: 16000 } } },
    ],
  ] as const)
    test(`${variant} compressed recording ${name}`, async () => {
      await withScenarioHarness(async (harness) => {
        const result = await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            env: {
              LIVEKIT_PROBE_UPLOADS: "1",
              ...(audio ? { LIVEKIT_AUDIO: JSON.stringify(audio) } : {}),
            },
          }),
        );
        const root = findLatestSpan(
          assertAudioTrace(harness.events()),
          "session",
        )!;
        const [segment] = audioSession(root).segments;
        expect(segment).toMatchObject({
          id: "part-0",
          state: "ready",
          mime_type: "audio/ogg",
          encoding: "opus",
          sample_rate_hz: 48000,
        });
        // The encoder's settings, defaults included, replace the PCM details.
        expect(segment.attributes).toEqual({
          "opus.bitrate_bps": audio ? 16000 : 64000,
          "opus.complexity": 5,
          "opus.application": "audio",
        });
        // The uploaded file decodes to the recorded duration, within rounding.
        const [upload] = uploadedAudio(result.stdout);
        expect(upload.format).toBe("ogg");
        expect(Math.abs(upload.decodedMs! - segment.duration_ms!)).toBeLessThan(
          1,
        );
        expect(
          (root.row.input as { audio: Record<string, unknown> }).audio[
            "part-0"
          ],
        ).toMatchObject({
          filename: "part-0.ogg",
          content_type: "audio/ogg",
        });
        expect(result.stderr).not.toContain("uncompressed PCM");
      });
    }, 120000);

  // Turning compression off records raw PCM, without a warning.
  test(`${variant} raw PCM recording with codec pcm`, async () => {
    await withScenarioHarness(async (harness) => {
      const result = await harness.runNodeScenarioDir(
        scenarioOptions(variant, {
          env: {
            LIVEKIT_PROBE_UPLOADS: "1",
            LIVEKIT_AUDIO: JSON.stringify({ codec: { name: "pcm" } }),
          },
        }),
      );
      const root = findLatestSpan(
        assertAudioTrace(harness.events()),
        "session",
      )!;
      expect(audioSession(root).segments).toMatchObject([
        {
          id: "part-0",
          state: "ready",
          mime_type: "audio/pcm",
          encoding: "pcm",
          sample_rate_hz: 24000,
          attributes: {
            "pcm.sample_format": "s16le",
            "pcm.channel_layout": "interleaved",
          },
        },
      ]);
      expect(uploadedAudio(result.stdout)).toEqual([{ format: "raw" }]);
      expect(result.stderr).not.toContain("uncompressed PCM");
    });
  }, 120000);

  test(`${variant} recording requires attachment capture`, async () => {
    await withScenarioHarness(async (harness) => {
      // The shared attachment flag alone never records calls.
      await harness.runNodeScenarioDir(
        scenarioOptions(variant, {
          recording: false,
          env: { BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS: "true" },
        }),
      );
      const events = assertAudioTrace(harness.events());
      // The call is still described, without recorded audio or attachments.
      const root = findLatestSpan(events, "session")!;
      expect(audioSession(root).session).toBeDefined();
      expect(audioSession(root).segments).toEqual([]);
      expect((root.row.input as { audio?: unknown })?.audio).toBeUndefined();
      // Played speech is still on the timeline: audio is opt-in, timing isn't.
      expect(selectionsOf(findLatestSpan(events, "agent_speech"))).not.toEqual(
        [],
      );
      await snapshotTrace(events, `${variant}-disabled`);
    });
  }, 120000);

  for (const mode of ["auto", "wrapped"] as const)
    test(`${variant} ${mode} order conversation`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, { mode, cassette: "order" }),
        );
        const events = assertAudioTrace(harness.events());
        // The underlying SDK integrations own model payloads and usage.
        expect(
          events.filter((e) => e.span.type === "llm").map((e) => e.span.name),
        ).toEqual([
          "Chat Completion",
          "Chat Completion",
          "openai.audio.speech.create",
        ]);
        // Typed input isn't heard, so no user turn has it; the agent turn it
        // prompted carries it.
        expect(
          findAllSpans(events, "user_turn").map((e) => e.row.input),
        ).not.toContainEqual(expect.anything());
        expect(findAllSpans(events, "agent_turn")[0]?.row.input).toEqual([
          { role: "user", content: expect.stringMatching(/order 1042/i) },
        ]);
        // Synthesis produced the played audio; the model produced its text.
        const [tts] = findAllSpans(events, "tts");
        expect(
          linkTargets(findLatestSpan(events, "agent_speech"), "generated_by"),
        ).toEqual([tts.span.id]);
        expect(linkTargets(tts, "generated_by")).toEqual([
          findAllSpans(events, "llm_response")[1].span.id,
        ]);
        await snapshotTrace(events, `${variant}-order`);
      });
    }, 120000);

  for (const mode of ["auto", "wrapped"] as const)
    test(`${variant} ${mode} provider instrumentation disabled leaves task wrappers only`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            mode,
            cassette: "order",
            recording: false,
            env: { LIVEKIT_OPENAI_INTEGRATION: "off" },
          }),
        );
        const events = assertAudioTrace(harness.events());
        expect(events.filter((e) => e.span.type === "llm")).toEqual([]);
        expect(findAllSpans(events, "llm_response")).toHaveLength(2);
        expect(findAllSpans(events, "tts")).toHaveLength(1);
      });
    }, 120000);

  for (const mode of ["auto", "wrapped"] as const)
    test(`${variant} ${mode} generic capture never enables provider voice attachments`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            mode,
            cassette: "order",
            recording: false,
            env: { BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS: "true" },
          }),
        );
        const events = assertAudioTrace(harness.events());
        expect(findAllSpans(events, "Chat Completion")).toHaveLength(2);
        expect(
          findLatestSpan(events, "openai.audio.speech.create")?.row.output,
        ).toEqual({ content: [] });
        expect(JSON.stringify(events.map((e) => e.row))).not.toContain(
          "braintrust_attachment",
        );
      });
    }, 120000);

  // A LiveKit Cloud project with redaction: LiveKit's own PII setting wins.
  for (const mode of ["auto", "wrapped"] as const)
    test(`${variant} ${mode} order conversation in a redacted LiveKit job`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            mode,
            entry: "redacted.mjs",
            cassette: "order",
            recording: false,
          }),
        );
        const events = assertAudioTrace(harness.events());
        // Nothing the caller or the model said, and no tool payloads.
        for (const name of ["llm_response", "agent_turn", "tts"])
          for (const span of findAllSpans(events, name)) {
            expect(span.row.input, name).toBeUndefined();
            if (name !== "agent_turn")
              expect(span.row.output, name).toBeUndefined();
          }
        expect(
          findLatestSpan(events, "lookup_order")?.row.input,
        ).toBeUndefined();
        expect(
          findLatestSpan(events, "lookup_order")?.row.output,
        ).toBeUndefined();
        expect(JSON.stringify(events.map((e) => e.row))).not.toMatch(
          /order 1042|Friday/i,
        );
        // Links still connect the call, holding only span IDs.
        const tool = findLatestSpan(events, "lookup_order");
        expect(linkTargets(tool, "requested_by")).toHaveLength(1);
        expect(
          linkTargets(
            findAllSpans(events, "llm_response")[1],
            "consumes_tool_result",
          ),
        ).toEqual([tool?.span.id]);
        // The call's shape, models and timing remain.
        expect(
          events.filter((e) => e.span.type === "llm").map((e) => e.span.name),
        ).toEqual([
          "Chat Completion",
          "Chat Completion",
          "openai.audio.speech.create",
        ]);
        expect(findLatestSpan(events, "llm_response")?.metadata).toMatchObject({
          model: expect.any(String),
        });
        expect(
          selectionsOf(findLatestSpan(events, "agent_speech")),
        ).not.toEqual([]);
      });
    }, 120000);

  for (const providerDisabled of [false, true])
    for (const direct of [false, true])
      for (const mode of ["auto", "wrapped"] as const)
        test(`${variant} ${mode} ${direct ? "direct client" : "SDK client"} discrete recognition${providerDisabled ? " provider disabled" : ""}`, async () => {
          await withScenarioHarness(async (harness) => {
            await harness.runNodeScenarioDir(
              scenarioOptions(variant, {
                mode,
                cassette: direct ? "direct" : "discrete",
                env: {
                  LIVEKIT_DISCRETE_STT: "1",
                  ...(providerDisabled
                    ? { LIVEKIT_OPENAI_INTEGRATION: "off" }
                    : {}),
                  ...(direct ? { LIVEKIT_DIRECT_CLIENT: "1" } : {}),
                },
              }),
            );
            const events = assertAudioTrace(harness.events());
            const stt = findAllSpans(events, "stt");
            expect(stt.length).toBeGreaterThan(0);
            const providers = findAllSpans(
              events,
              direct ? "livekit.stt" : "openai.audio.transcriptions.create",
            );
            expect(providers).toHaveLength(
              providerDisabled && !direct ? 0 : stt.length,
            );
            for (const provider of providers) {
              expect(stt.map((s) => s.span.id)).toContain(
                provider.span.parentIds[0],
              );
              expect(provider.row.input).toMatchObject({
                operation: "transcribe",
              });
              expect(provider.row.output).toMatchObject({
                content: [
                  { type: "text", text: expect.stringMatching(/order/i) },
                ],
              });
              if (direct) {
                // This custom adapter does not expose transcription usage.
                expect(provider.metrics).not.toHaveProperty("tokens");
              } else {
                expect(provider.metrics?.tokens).toBeGreaterThan(0);
                expect(provider.metrics?.tokens).toBe(
                  (provider.metrics!.prompt_tokens as number) +
                    (provider.metrics!.completion_tokens as number),
                );
              }
            }
            for (const model of findAllSpans(
              events,
              direct ? "livekit.llm_response" : "Chat Completion",
            )) {
              expect(model.metrics?.tokens).toBeGreaterThan(0);
              expect(model.metrics?.tokens).toBe(
                (model.metrics!.prompt_tokens as number) +
                  (model.metrics!.completion_tokens as number),
              );
            }
            for (const synthesis of findAllSpans(
              events,
              direct ? "livekit.tts" : "openai.audio.speech.create",
            ))
              expect(synthesis.metrics).not.toHaveProperty("tokens");
            if (!direct)
              expect(findAllSpans(events, "livekit.stt")).toHaveLength(0);
            if (direct) {
              expect(findAllSpans(events, "livekit.llm_response")).toHaveLength(
                2,
              );
              expect(findAllSpans(events, "livekit.tts")).toHaveLength(1);
              expect(findAllSpans(events, "Chat Completion")).toHaveLength(0);
            }
            if (providerDisabled && !direct)
              expect(events.filter((e) => e.span.type === "llm")).toHaveLength(
                0,
              );
            if (!providerDisabled)
              await snapshotTrace(
                events,
                `${variant}-${direct ? "direct" : "discrete"}`,
              );
          });
        }, 120000);

  for (const mode of ["auto", "wrapped", "wrapped-auto"] as const)
    test(`${variant} ${mode} streaming-cascade order conversation`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            cassette: "streaming-cascade",
            mode,
            env: {
              LIVEKIT_STREAMING_STT: "1",
              LIVEKIT_WS_PATH: `${originalScenarioDir}/__cassettes__/${variant}-streaming-cascade.websocket.json`,
              BRAINTRUST_E2E_CASSETTE_MODE:
                process.env.BRAINTRUST_E2E_CASSETTE_MODE ?? "replay",
              OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "replay",
            },
          }),
        );
        const events = assertAudioTrace(harness.events());
        const user = findLatestSpan(events, "user_speech");
        // User speech is observed audio: its source and its place on the
        // timeline, from LiveKit's local VAD, but no text.
        expect(user?.metadata?.["audio.source_id"]).toBe("session-input");
        expect(user?.row.input).toBeUndefined();
        expect(selectionsOf(user)).toHaveLength(1);
        expect(
          selectionsOf(
            findAllSpans(events, "user_turn").find((e) => e.row.input),
          ),
        ).toHaveLength(1);
        // Each SDK request has one model child, including combined LiveKit hooks.
        const responses = findAllSpans(events, "llm_response");
        const completions = findAllSpans(events, "Chat Completion");
        expect(responses).toHaveLength(2);
        expect(completions).toHaveLength(2);
        for (const response of responses) {
          const requests = completions.filter(
            (model) => model.span.parentIds[0] === response.span.id,
          );
          expect(requests).toHaveLength(1);
          expect(requests[0].metrics?.tokens).toBeGreaterThan(0);
        }
        // Receipt-only transcripts link the model to the turn it answers.
        const stt = findAllSpans(events, "transcript_received");
        expect(stt.length).toBeGreaterThan(0);
        expect(contextLinks(findAllSpans(events, "llm_response")[0])).toEqual(
          stt.map((span) => span.span.id),
        );
        const waits = findAllSpans(events, "eou_wait");
        expect(waits.length).toBeGreaterThan(0);
        for (const wait of waits) {
          expect(wait.span.type).toBe("task");
          expect(wait.metadata).toMatchObject({
            "eou.outcome": "committed",
            "eou.speech_end_source": "vad",
            "audio.source_id": "session-input",
          });
          expect(wait.metadata?.["turn.id"]).toBe(wait.span.parentIds[0]);
          expect(wait.metadata).not.toHaveProperty("eou.end_reason");
          expect(wait.metadata).not.toHaveProperty("eou.detection_methods");
          expect(wait.metrics?.end).toBeGreaterThanOrEqual(
            wait.metrics?.start as number,
          );
        }
        await snapshotTrace(events, `${variant}-streaming-cascade`);
      });
    }, 120000);

  // Two callers share one microphone; diarized STT tells their voices apart.
  test(`${variant} diarized two-caller conversation`, async () => {
    await withScenarioHarness(async (harness) => {
      await harness.runNodeScenarioDir(
        scenarioOptions(variant, {
          cassette: "diarized",
          env: {
            LIVEKIT_DIARIZATION: "1",
            LIVEKIT_WS_PATH: `${originalScenarioDir}/__cassettes__/${variant}-diarized.websocket.json`,
            BRAINTRUST_E2E_CASSETTE_MODE:
              process.env.BRAINTRUST_E2E_CASSETTE_MODE ?? "replay",
            OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "replay",
            LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? "replay",
            LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? "replay",
          },
        }),
      );
      const events = assertAudioTrace(harness.events());
      const { session } = audioSession(findLatestSpan(events, "session"));
      // Each labeled transcript names its speaker; LiveKit's own label is an
      // index, kept as a native attribute rather than a display name.
      const speakers = session?.speakers ?? {};
      expect(Object.values(speakers)).toEqual([
        {
          type: "user",
          attributes: { "contrib.livekit.speaker_id": expect.any(String) },
        },
        {
          type: "user",
          attributes: { "contrib.livekit.speaker_id": expect.any(String) },
        },
      ]);
      const labeled = findAllSpans(events, "transcript_received").filter(
        (span) => span.metadata?.["audio.speaker_ids"],
      );
      expect(labeled.length).toBeGreaterThan(1);
      for (const span of labeled) {
        const [speaker] = span.metadata?.["audio.speaker_ids"] as string[];
        expect(
          speakers[speaker]?.attributes?.["contrib.livekit.speaker_id"],
        ).toBe(span.metadata?.["contrib.livekit.speaker_id"]);
      }
      expect(
        new Set(
          labeled.map((span) => span.metadata?.["contrib.livekit.speaker_id"]),
        ),
      ).toHaveProperty("size", 2);
      // Receipt-only callbacks keep their receipt timestamp and user turn.
      for (const span of findAllSpans(events, "transcript_received")) {
        const parent = events.find((e) => e.span.id === span.span.parentIds[0]);
        expect(parent?.span.name).toBe("user_turn");
        const { start, end } = span.row.metrics as {
          start: number;
          end: number;
        };
        expect(end).toBe(start);
      }
      // Speech is audio activity: it names no speaker and links to no transcript.
      for (const span of findAllSpans(events, "user_speech")) {
        expect(span.metadata).not.toHaveProperty("audio.speaker_ids");
        expect(span.metadata?.links).toBeUndefined();
      }
      // The turn carries LiveKit's transcript for it, and its message's identity.
      const turn = findAllSpans(events, "user_turn").find((e) => e.row.input);
      expect(turn?.row.input).toEqual([
        { role: "user", content: expect.stringMatching(/heard anything/i) },
      ]);
      expect(turn?.metadata).toMatchObject({
        "contrib.livekit.message_id": expect.any(String),
        "contrib.livekit.started_speaking_at": expect.any(Number),
        "contrib.livekit.stopped_speaking_at": expect.any(Number),
      });
      // The answer's context is every transcript of the turn, from both callers.
      expect(contextLinks(findAllSpans(events, "llm_response")[0])).toEqual(
        findAllSpans(events, "transcript_received").map((span) => span.span.id),
      );
      // No LiveKit room, so no room connections: no participants are invented.
      expect(session).not.toHaveProperty("participants", expect.anything());
      expect(
        findLatestSpan(events, "agent_speech")?.metadata,
      ).not.toHaveProperty("audio.participant_ids");
      await snapshotTrace(events, `${variant}-diarized`);
    });
  }, 120000);

  for (const recover of [false, true])
    test(`${variant} ${recover ? "recovered" : "interrupted"} order answer`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            cassette: recover ? "recovered" : "order",
            env: {
              LIVEKIT_INTERRUPT: "1",
              LIVEKIT_RECOVER: recover ? "1" : "0",
            },
          }),
        );
        const events = assertAudioTrace(harness.events());
        const interrupted = events.find(
          (e) =>
            e.span.name === "agent_speech" &&
            e.metadata?.["contrib.livekit.interrupted"],
        );
        expect(selectionsOf(interrupted)).not.toEqual([]);
        if (recover) {
          const resumed = findLatestSpan(events, "agent_speech");
          expect(resumed?.span.id).not.toBe(interrupted?.span.id);
          spoken(resumed, /Friday/i);
        }
        await snapshotTrace(
          events,
          `${variant}-${recover ? "recovered" : "interrupted"}`,
        );
      });
    }, 120000);

  // Rotation is anchored to session time, so a delayed playback start changes the
  // number of files. Assert complete, contiguous coverage instead of a snapshot.
  test(`${variant} progressive order recording`, async () => {
    await withScenarioHarness(async (harness) => {
      const result = await harness.runNodeScenarioDir(
        scenarioOptions(variant, {
          cassette: "order",
          env: {
            LIVEKIT_SEGMENTS: "1",
            LIVEKIT_PLAYBACK_START_DELAY_MS: "137",
          },
        }),
      );
      const events = assertAudioTrace(harness.events());
      const root = findLatestSpan(events, "session")!;
      const { segments } = audioSession(root);
      expect(segments.length).toBeGreaterThan(1);
      const attachments = (
        root.row.input as { audio: Record<string, { key: string }> }
      ).audio;
      expect(Object.keys(attachments).sort()).toEqual(
        segments.map((s) => s.id).sort(),
      );
      for (const [index, segment] of segments.entries()) {
        expect(segment).toMatchObject({
          id: `part-${index}`,
          state: "ready",
        });
        expect(segment.duration_ms).toBeLessThanOrEqual(200);
        // Whole milliseconds, tiled without drift.
        if (index > 0)
          expect(segment.start_offset_ms).toBe(
            segments[index - 1].start_offset_ms +
              segments[index - 1].duration_ms!,
          );
      }
      const { playedDurationMs, completedUploads } = JSON.parse(
        result.stdout
          .split("\n")
          .find((line) => line.startsWith('{"playedDurationMs":'))!,
      );
      // A successful upload must precede the final frame, without forceFlush.
      expect(
        completedUploads.some(
          (upload: { key: string; playedSamples: number }) =>
            upload.playedSamples > 0 &&
            upload.playedSamples / 24 < playedDurationMs &&
            Object.values(attachments).some((a) => a.key === upload.key),
        ),
      ).toBe(true);
      // Played speech is one interval on the session timeline, even across files.
      const selections = selectionsOf(findLatestSpan(events, "agent_speech"));
      expect(selections.length).toBeGreaterThan(0);
      const first = selections[0];
      expect(first.start_offset_ms).toBeLessThan(segments[1].start_offset_ms);
      expect(first.end_offset_ms).toBeGreaterThan(segments[1].start_offset_ms);
      const selectedMs = selections.reduce(
        (sum, s) => sum + s.end_offset_ms - s.start_offset_ms,
        0,
      );
      expect(Math.abs(selectedMs - playedDurationMs)).toBeLessThanOrEqual(
        selections.length,
      );
    });
  }, 120000);

  // Automatic setup in other runtimes and next to an application OTel provider.
  for (const setup of ["unsampled", "integration-off", "worker"] as const)
    test(`${variant} automatic setup ${setup}`, async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            recording: false,
            entry: setup === "worker" ? "worker.mjs" : "scenario.mjs",
            env: {
              LIVEKIT_OTEL: setup === "unsampled" ? "unsampled" : "",
              LIVEKIT_INTEGRATION: setup === "integration-off" ? "off" : "",
            },
          }),
        );
        const events = assertAudioTrace(harness.events());
        if (setup === "integration-off") {
          expect(events).toHaveLength(0);
          return;
        }
        expect(findAllSpans(events, "session")).toHaveLength(1);
        spoken(findLatestSpan(events, "agent_speech"), /Fixture playback/);
      });
    }, 90000);
}
