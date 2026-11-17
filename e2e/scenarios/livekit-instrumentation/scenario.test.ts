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
        // Provider spans inside LiveKit inference are suppressed.
        expect(
          events.filter((e) => e.span.type === "llm").map((e) => e.span.name),
        ).toEqual(["llm_response", "llm_response"]);
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
        ).toEqual(["llm_response", "llm_response"]);
        expect(findLatestSpan(events, "llm_response")?.metadata).toMatchObject({
          model: expect.any(String),
        });
        expect(
          selectionsOf(findLatestSpan(events, "agent_speech")),
        ).not.toEqual([]);
      });
    }, 120000);

  test(`${variant} streaming-cascade order conversation`, async () => {
    await withScenarioHarness(async (harness) => {
      await harness.runNodeScenarioDir(
        scenarioOptions(variant, {
          cassette: "streaming-cascade",
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
      // LiveKit has no native STT span; each final transcript gets one, and the
      // model's context links to the transcripts of the turn it answers.
      const stt = findAllSpans(events, "stt");
      expect(stt.length).toBeGreaterThan(0);
      expect(contextLinks(findAllSpans(events, "llm_response")[0])).toEqual(
        stt.map((span) => span.span.id),
      );
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
      const labeled = findAllSpans(events, "stt").filter(
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
      // Each recognition is a span from its first result to its final, under
      // the user turn it began in.
      for (const span of findAllSpans(events, "stt")) {
        const parent = events.find((e) => e.span.id === span.span.parentIds[0]);
        expect(parent?.span.name).toBe("user_turn");
        const { start, end } = span.row.metrics as {
          start: number;
          end: number;
        };
        expect(end).toBeGreaterThan(start);
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
        findAllSpans(events, "stt").map((span) => span.span.id),
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
