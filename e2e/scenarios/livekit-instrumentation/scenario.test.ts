import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { assertAudioTrace } from "./assertions";
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
    test.sequential(
      `${variant} ${mode} fixture recording`,
      async () => {
        await withScenarioHarness(async (harness) => {
          await harness.runNodeScenarioDir(scenarioOptions(variant, { mode }));
          const events = assertAudioTrace(harness.events());
          const root = findAllSpans(events, "session");
          expect(root).toHaveLength(1);
          expect(root[0].metadata?.["audio.recordings"]).toMatchObject([
            { id: "call-0000", state: "ready", channel_count: 2 },
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
      },
      120000,
    );

  test.sequential(
    `${variant} recording requires attachment capture`,
    async () => {
      await withScenarioHarness(async (harness) => {
        // The shared attachment flag alone never records calls.
        await harness.runNodeScenarioDir(
          scenarioOptions(variant, {
            recording: false,
            env: { BRAINTRUST_CAPTURE_ATTACHMENTS: "true" },
          }),
        );
        const events = assertAudioTrace(harness.events());
        expect(
          events.some((e) => e.metadata?.["audio.recordings"] !== undefined),
        ).toBe(false);
        await snapshotTrace(events, `${variant}-disabled`);
      });
    },
    120000,
  );

  for (const mode of ["auto", "wrapped"] as const)
    test.sequential(
      `${variant} ${mode} order conversation`,
      async () => {
        await withScenarioHarness(async (harness) => {
          await harness.runNodeScenarioDir(
            scenarioOptions(variant, { mode, cassette: "order" }),
          );
          const events = assertAudioTrace(harness.events());
          // Provider spans inside LiveKit inference are suppressed.
          expect(
            events.filter((e) => e.span.type === "llm").map((e) => e.span.name),
          ).toEqual(["llm_response", "llm_response"]);
          await snapshotTrace(events, `${variant}-order`);
        });
      },
      120000,
    );

  test.sequential(
    `${variant} streaming-cascade order conversation`,
    async () => {
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
        const user = findAllSpans(events, "user_speech").find((e) =>
          Array.isArray(e.row.input),
        );
        expect(user?.metadata?.["audio.selections"]).not.toEqual([]);
        // LiveKit has no native STT span; each final transcript gets one.
        const stt = findAllSpans(events, "stt");
        expect(stt.length).toBeGreaterThan(0);
        expect(user?.metadata?.links).toEqual(
          expect.arrayContaining(
            stt.map((span) =>
              expect.objectContaining({
                context: expect.objectContaining({ spanId: span.span.id }),
                attributes: {
                  "braintrust.relationship.type": "transcribed_by",
                },
              }),
            ),
          ),
        );
        await snapshotTrace(events, `${variant}-streaming-cascade`);
      });
    },
    120000,
  );

  for (const recover of [false, true])
    test.sequential(
      `${variant} ${recover ? "recovered" : "interrupted"} order answer`,
      async () => {
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
          expect(interrupted?.metadata?.["audio.selections"]).not.toEqual([]);
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
      },
      120000,
    );

  // Rotation is anchored to session time, so a delayed playback start changes the
  // number of files. Assert complete, contiguous coverage instead of a snapshot.
  test.sequential(
    `${variant} progressive order recording`,
    async () => {
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
        const recordings = root.metadata?.["audio.recordings"] as {
          id: string;
          state: string;
          duration_ms: number;
          timeline: { recording_start_offset_ms: number };
        }[];
        expect(recordings.length).toBeGreaterThan(1);
        const attachments = (
          root.row.input as { audio: Record<string, { key: string }> }
        ).audio;
        expect(Object.keys(attachments).sort()).toEqual(
          recordings.map((r) => r.id).sort(),
        );
        for (const [index, recording] of recordings.entries()) {
          expect(recording).toMatchObject({
            id: `call-${String(index).padStart(4, "0")}`,
            state: "ready",
          });
          expect(recording.duration_ms).toBeLessThanOrEqual(200.05);
          if (index > 0)
            expect(recording.timeline.recording_start_offset_ms).toBeCloseTo(
              recordings[index - 1].timeline.recording_start_offset_ms +
                recordings[index - 1].duration_ms,
              1,
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
        for (const name of ["agent_turn", "agent_speech"]) {
          const selections = findLatestSpan(events, name)!.metadata?.[
            "audio.selections"
          ] as {
            recording_id: string;
            start_offset_ms: number;
            end_offset_ms: number;
          }[];
          expect(selections.map((s) => s.recording_id)).toEqual(
            recordings.map((r) => r.id),
          );
          let selectedMs = 0;
          let previousEnd: number | undefined;
          for (const selection of selections) {
            const offset = recordings.find(
              (r) => r.id === selection.recording_id,
            )!.timeline.recording_start_offset_ms;
            if (previousEnd !== undefined)
              expect(offset + selection.start_offset_ms).toBeCloseTo(
                previousEnd,
                1,
              );
            previousEnd = offset + selection.end_offset_ms;
            selectedMs += selection.end_offset_ms - selection.start_offset_ms;
          }
          expect(selectedMs).toBeCloseTo(playedDurationMs, 1);
        }
      });
    },
    120000,
  );

  // Automatic setup in other runtimes and next to an application OTel provider.
  for (const setup of ["unsampled", "integration-off", "worker"] as const)
    test.sequential(
      `${variant} automatic setup ${setup}`,
      async () => {
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
      },
      90000,
    );
}
