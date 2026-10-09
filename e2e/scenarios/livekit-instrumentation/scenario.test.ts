import { assertAudioTrace } from "./assertions";
import { expect, test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";
import { findLatestSpan, findAllSpans } from "../../helpers/trace-selectors";
import { spanTreeFields, matchSpanTreeSnapshot } from "../../helpers/span-tree";
import { resolveFileSnapshotPath } from "../../helpers/file-snapshot";
function normalizer() {
  const ids = new Map<string, string>();
  function stable(value: unknown, key = ""): unknown {
    if (
      typeof value === "number" &&
      /(_ms|_at|transcription_delay|end_of_turn_delay|on_user_turn_completed_delay|e2e_latency|At|wait_duration|queue_wait|playback_latency|playbackPosition|ttft|ttfb|time_to_first_chunk|time_to_first_token|timestamp|ttfbMs|durationMs|tokensPerSecond)$/.test(
        key,
      )
    )
      return 0;
    if (typeof value === "string" && key.endsWith("_metrics")) {
      try {
        return stable(JSON.parse(value));
      } catch {}
    }
    if (
      typeof value === "string" &&
      (/^(item_|speech_)/.test(value) ||
        /^[0-9a-f]{8}-[0-9a-f]{3}$/.test(value))
    ) {
      if (!ids.has(value)) ids.set(value, `<native:${ids.size + 1}>`);
      return ids.get(value);
    }
    if (typeof value === "string" && /^127\.0\.0\.1:\d+$/.test(value))
      return "<provider-host>";
    if (Array.isArray(value)) return value.map((v) => stable(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          /^(item_|speech_)/.test(k) ? stable(k) : k,
          stable(v, k),
        ]),
      );
    return value;
  }
  return stable;
}
const originalScenarioDir = resolveScenarioDir(import.meta.url);
const scenarioDir = await prepareScenarioDir({
  scenarioDir: originalScenarioDir,
});
// Native LiveKit I/O modes plus real-provider cassette conversations below.
for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  for (const mode of ["wrapped", "auto", "wrapped-auto", "disabled"]) {
    test.sequential(
      `${variant} ${mode}`,
      async () => {
        await withScenarioHarness(async (harness) => {
          await harness.runNodeScenarioDir({
            scenarioDir,
            entry: "scenario.mjs",
            timeoutMs: 60000,
            nodeArgs:
              mode === "wrapped" ? [] : ["--import", "braintrust/hook.mjs"],
            env: {
              LIVEKIT_PACKAGE: variant,
              LIVEKIT_WRAP: mode.includes("wrapped") ? "1" : "0",
              LIVEKIT_AUDIO: mode === "disabled" ? "0" : "1",
            },
            runContext: {
              variantKey: variant,
              originalScenarioDir,
              cassette: false,
            },
          });
          const stable = normalizer();
          const raw = harness.events();
          assertAudioTrace(raw);
          const events = [...new Set(raw.map((e) => e.span.name))].flatMap(
            (name) => findAllSpans(raw, name!),
          );
          const root = findLatestSpan(events, "livekit.agent_session");
          const turn = findLatestSpan(events, "assistant_turn");
          expect(root).toBeDefined();
          expect(turn).toBeDefined();
          expect(
            new Set(
              events
                .filter((e) => e.span.name === "livekit.agent_session")
                .map((e) => e.span.id),
            ).size,
          ).toBe(1);
          const recordings = root!.row.metadata?.["audio.recordings"];
          if (mode === "disabled") expect(recordings).toBeUndefined();
          else {
            expect(recordings).toMatchObject([
              {
                state: "ready",
                channel_count: 2,
                attachment: {
                  span_id: root!.span.id,
                  ref: "/input/audio/call-0000",
                },
              },
            ]);
            expect(turn!.row.metadata?.["audio.selections"]).toMatchObject([
              { channel_index: 1, recording_span_id: root!.span.id },
            ]);
          }
          await matchSpanTreeSnapshot(
            events.map((event) => ({
              event,
              fields: stable({
                ...spanTreeFields(event),
                context: event.row.context,
              }) as Record<string, unknown>,
            })),
            resolveFileSnapshotPath(
              import.meta.url,
              `${variant}-${mode === "disabled" ? "disabled" : "audio"}.span-tree.json`,
            ),
          );
        });
      },
      120000,
    );
  }
}

for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  test.sequential(
    `${variant} order conversation`,
    async () => {
      await withScenarioHarness(async (harness) => {
        await harness.runNodeScenarioDir({
          scenarioDir,
          entry: "scenario.mjs",
          timeoutMs: 90000,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          env: {
            LIVEKIT_PACKAGE: variant,
            LIVEKIT_PROVIDER: "1",
            LIVEKIT_AUDIO: "1",
            BRAINTRUST_DISABLE_INSTRUMENTATION: "",
          },
          runContext: {
            variantKey: variant,
            cassette: { variantKey: `${variant}-order` },
            originalScenarioDir,
          },
        });
        const stable = normalizer();
        const raw = harness.events();
        assertAudioTrace(raw);
        const events = [...new Set(raw.map((e) => e.span.name))].flatMap(
          (name) => findAllSpans(raw, name!),
        );
        const turn = findLatestSpan(events, "assistant_turn");
        expect(turn).toBeDefined();
        const responses = events.filter((e) => e.span.name === "llm_response");
        expect(
          events
            .filter((e) => e.row.span_attributes?.type === "llm")
            .map((e) => e.span.name),
        ).toEqual(responses.map((e) => e.span.name));
        expect(responses).toHaveLength(2);
        expect(
          responses.every((e) => e.row.metadata?.["turn.id"] === turn!.span.id),
        ).toBe(true);
        expect(
          responses.every((e) => e.row.metadata?.model === "gpt-4.1-nano"),
        ).toBe(true);
        expect(responses.every((e) => Number(e.row.metrics?.tokens) > 0)).toBe(
          true,
        );
        const tool = findLatestSpan(events, "lookup_order");
        expect(tool?.row.input).toEqual({ order_id: "1042" });
        expect(tool?.row.output).toMatchObject({ delivery: "Friday" });
        const callId = tool!.row.metadata?.["gen_ai.tool.call.id"];
        expect(
          responses.some((e) =>
            (
              e.row.metadata?.["continuation.tool_call_ids"] as unknown[]
            )?.includes(callId),
          ),
        ).toBe(true);
        expect(turn!.row.output).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: expect.stringMatching(/Friday/i),
            }),
          ]),
        );
        expect(findLatestSpan(events, "tts")).toBeDefined();
        expect(JSON.stringify(events.map((e) => e.row.metadata))).not.toContain(
          '"livekit.',
        );
        await matchSpanTreeSnapshot(
          events.map((event) => ({
            event,
            fields: stable({
              ...spanTreeFields(event),
              context: event.row.context,
            }) as Record<string, unknown>,
          })),
          resolveFileSnapshotPath(
            import.meta.url,
            `${variant}-order.span-tree.json`,
          ),
        );
      });
    },
    120000,
  );
}

for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  for (const [scheme, burst] of [
    "realtime",
    "duplex",
    "duplex-overlap",
    "streaming-cascade",
    "half-cascade",
    "reconnect",
  ].flatMap<[string, boolean]>((scheme) =>
    scheme === "half-cascade"
      ? [
          [scheme, false],
          [scheme, true],
        ]
      : [[scheme, false]],
  ))
    test.sequential(
      `${variant} ${scheme}${burst ? " burst" : ""} order conversation`,
      async () => {
        await withScenarioHarness(async (harness) => {
          await harness.runNodeScenarioDir({
            scenarioDir,
            entry: "scenario.mjs",
            timeoutMs: 90000,
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            env: {
              LIVEKIT_PACKAGE: variant,
              LIVEKIT_PROVIDER: "1",
              LIVEKIT_WS_BURST: burst ? "1" : "0",
              LIVEKIT_REALTIME: scheme === "streaming-cascade" ? "0" : "1",
              LIVEKIT_STREAMING_STT: scheme === "streaming-cascade" ? "1" : "0",
              LIVEKIT_RECONNECT: scheme === "reconnect" ? "1" : "0",
              LIVEKIT_HALF_CASCADE: scheme === "half-cascade" ? "1" : "0",
              LIVEKIT_DUPLEX: scheme.startsWith("duplex") ? "1" : "0",
              LIVEKIT_OVERLAP: scheme === "duplex-overlap" ? "1" : "0",
              LIVEKIT_AUDIO: "1",
              LIVEKIT_WS_PATH: `${originalScenarioDir}/__cassettes__/${variant}-${scheme}.websocket.json`,
              BRAINTRUST_E2E_CASSETTE_MODE:
                process.env.BRAINTRUST_E2E_CASSETTE_MODE ?? "replay",
              BRAINTRUST_DISABLE_INSTRUMENTATION: "",
              OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "replay",
            },
            runContext: {
              variantKey: variant,
              originalScenarioDir,
              cassette: ["streaming-cascade", "half-cascade"].includes(scheme)
                ? { variantKey: `${variant}-${scheme}` }
                : false,
            },
          });
          const stable = normalizer();
          const raw = harness.events();
          assertAudioTrace(raw);
          const events = [...new Set(raw.map((e) => e.span.name))].flatMap(
            (name) => findAllSpans(raw, name!),
          );
          expect(
            findLatestSpan(events, "lookup_order")?.row.output,
          ).toMatchObject({ delivery: "Friday" });
          expect(
            events.filter((e) => e.span.name === "llm_response").length,
          ).toBeGreaterThanOrEqual(2);
          const turn = findLatestSpan(events, "assistant_turn");
          expect(turn?.row.output).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "assistant",
                content: expect.stringMatching(/Friday/i),
              }),
            ]),
          );
          if (scheme === "reconnect")
            expect(
              events.filter(
                (e) =>
                  e.span.name === "user_turn" &&
                  e.row.metadata?.["contrib.livekit.item_id"],
              ),
            ).toHaveLength(2);
          if (scheme.startsWith("duplex")) {
            const callers = events.filter(
              (e) =>
                e.span.name === "user_turn" &&
                e.row.metadata?.["contrib.livekit.item_id"],
            );
            expect(callers).toHaveLength(scheme === "duplex-overlap" ? 2 : 1);
            if (scheme === "duplex-overlap")
              expect(callers[1].row.input).toEqual([
                expect.objectContaining({
                  role: "user",
                  content: expect.stringMatching(/Thanks.*delivery.*detail/i),
                }),
              ]);
            expect(callers[0].row.input).toEqual([
              expect.objectContaining({
                role: "user",
                content: expect.stringMatching(
                  /Where is my order.*(?:1042|one zero four two)/i,
                ),
              }),
            ]);
          }
          const user = events.find(
            (e) =>
              e.span.name === "user_turn" &&
              (e.row.metadata?.["contrib.livekit.item_id"] ||
                (scheme === "streaming-cascade" &&
                  Array.isArray(e.row.input) &&
                  e.row.input.some(
                    (message) => message?.role === "user" && message.content,
                  ))),
          );
          expect(user?.row.input).toEqual([
            expect.objectContaining({
              role: "user",
              content: expect.stringMatching(/order/i),
            }),
          ]);
          expect(user?.row.metadata?.["audio.selections"]).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ channel_index: 0 }),
            ]),
          );
          expect(
            events
              .filter((e) => e.span.name === "llm_response")
              .every((e) => Array.isArray(e.row.output)),
          ).toBe(true);
          if (["half-cascade", "streaming-cascade"].includes(scheme))
            expect(findLatestSpan(events, "tts")).toBeDefined();
          else expect(findLatestSpan(events, "tts")).toBeUndefined();
          if (scheme === "streaming-cascade")
            expect(user?.row.metadata?.model).toBe("gpt-4o-mini-transcribe");
          await matchSpanTreeSnapshot(
            events.map((event) => ({
              event,
              fields: stable({
                ...spanTreeFields(event),
                context: event.row.context,
              }) as Record<string, unknown>,
            })),
            resolveFileSnapshotPath(
              import.meta.url,
              `${variant}-${scheme}.span-tree.json`,
            ),
          );
        });
      },
      120000,
    );
}

for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  for (const recover of [false, true])
    test.sequential(
      `${variant} ${recover ? "recovered" : "interrupted"} order answer`,
      async () => {
        await withScenarioHarness(async (harness) => {
          await harness.runNodeScenarioDir({
            scenarioDir,
            entry: "scenario.mjs",
            timeoutMs: 90000,
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            env: {
              LIVEKIT_PACKAGE: variant,
              LIVEKIT_PROVIDER: "1",
              LIVEKIT_AUDIO: "1",
              LIVEKIT_INTERRUPT: "1",
              LIVEKIT_RECOVER: recover ? "1" : "0",
              BRAINTRUST_DISABLE_INSTRUMENTATION: "",
            },
            runContext: {
              variantKey: variant,
              cassette: {
                variantKey: `${variant}-${recover ? "recovered" : "order"}`,
              },
              originalScenarioDir,
            },
          });
          const raw = harness.events();
          assertAudioTrace(raw);
          const events = [...new Set(raw.map((e) => e.span.name))].flatMap(
            (name) => findAllSpans(raw, name!),
          );
          const turn = events.find(
            (e) =>
              e.span.name === "assistant_turn" &&
              e.row.metadata?.["contrib.livekit.interrupted"],
          );
          if (recover) {
            const resumed = findLatestSpan(events, "assistant_turn");
            expect(resumed?.span.id).not.toBe(turn?.span.id);
            expect(resumed?.row.metadata?.["contrib.livekit.interrupted"]).toBe(
              false,
            );
            expect(resumed?.row.output).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "assistant",
                  content: expect.stringMatching(/Friday/i),
                }),
              ]),
            );
            expect(resumed?.row.metadata?.["audio.selections"]).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ channel_index: 1 }),
              ]),
            );
          }
          expect(turn?.row.metadata?.["contrib.livekit.interrupted"]).toBe(
            true,
          );
          expect(turn?.row.metadata?.["audio.selections"]).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ channel_index: 1 }),
            ]),
          );
          expect(
            turn?.row.metadata?.["contrib.livekit.playback_events"],
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                attributes: expect.objectContaining({ interrupted: true }),
              }),
            ]),
          );
          const stable = normalizer();
          await matchSpanTreeSnapshot(
            events.map((event) => ({
              event,
              fields: stable({
                ...spanTreeFields(event),
                context: event.row.context,
              }) as Record<string, unknown>,
            })),
            resolveFileSnapshotPath(
              import.meta.url,
              `${variant}-${recover ? "recovered" : "interrupted"}.span-tree.json`,
            ),
          );
        });
      },
      120000,
    );
}

for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  test.sequential.each([0, 137])(
    `${variant} progressive Ogg order recording (%i ms start delay)`,
    async (startDelayMs) => {
      await withScenarioHarness(async (harness) => {
        const result = await harness.runNodeScenarioDir({
          scenarioDir,
          entry: "scenario.mjs",
          timeoutMs: 90000,
          nodeArgs: ["--import", "braintrust/hook.mjs"],
          env: {
            LIVEKIT_PACKAGE: variant,
            LIVEKIT_PROVIDER: "1",
            LIVEKIT_AUDIO: "1",
            LIVEKIT_SEGMENTS: "1",
            LIVEKIT_PLAYBACK_START_DELAY_MS: String(startDelayMs),
            BRAINTRUST_DISABLE_INSTRUMENTATION: "",
          },
          runContext: {
            variantKey: variant,
            cassette: { variantKey: `${variant}-order` },
            originalScenarioDir,
          },
        });
        const raw = harness.events();
        assertAudioTrace(raw);
        const events = [...new Set(raw.map((e) => e.span.name))].flatMap(
          (name) => findAllSpans(raw, name!),
        );
        const root = findLatestSpan(events, "livekit.agent_session")!;
        const descriptors = root.row.metadata?.["audio.recordings"] as {
          id: string;
          state: string;
          mime_type: string;
          recording_group_id: string;
          duration_ms: number;
          attachment: { span_id: string; ref: string };
          timeline: { recording_start_offset_ms: number };
        }[];
        // Rotation is anchored to session time, so startup latency changes the
        // number of files. Assert complete playback coverage rather than a fixed
        // segment-count snapshot; the ordinary audio case snapshots trace shape.
        expect(descriptors.length).toBeGreaterThan(1);
        const attachments = (
          root.row.input as {
            audio: Record<
              string,
              { key: string; filename: string; content_type: string }
            >;
          }
        ).audio;
        expect(Object.keys(attachments).sort()).toEqual(
          descriptors.map((r) => r.id).sort(),
        );
        const requests = harness.requestsAfter(0);
        for (const [index, recording] of descriptors.entries()) {
          expect(recording).toMatchObject({
            id: `call-${String(index).padStart(4, "0")}`,
            state: "ready",
            mime_type: "audio/ogg",
            recording_group_id: "call",
            attachment: {
              span_id: root.span.id,
              ref: `/input/audio/${recording.id}`,
            },
          });
          expect(recording.duration_ms).toBeGreaterThan(0);
          expect(recording.duration_ms).toBeLessThanOrEqual(200.05);
          if (index > 0) {
            const previous = descriptors[index - 1];
            expect(recording.timeline.recording_start_offset_ms).toBeCloseTo(
              previous.timeline.recording_start_offset_ms +
                previous.duration_ms,
              1,
            );
          }
          const attachment = attachments[recording.id];
          expect(attachment).toMatchObject({
            filename: `${recording.id}.ogg`,
            content_type: "audio/ogg",
          });
          expect(
            requests.some(
              (r) =>
                r.path === "/attachment/status" &&
                (r.jsonBody as { key?: string })?.key === attachment.key &&
                (r.jsonBody as { status?: { upload_status?: string } })?.status
                  ?.upload_status === "done",
            ),
          ).toBe(true);
        }
        const diagnostic = result.stdout
          .split("\n")
          .find((line) => line.startsWith('{"playedDurationMs":'));
        expect(diagnostic).toBeDefined();
        const { playedDurationMs, completedUploads } = JSON.parse(diagnostic!);
        expect(playedDurationMs).toBeGreaterThan(0);
        // A successful upload must precede the final frame, without forceFlush.
        expect(
          completedUploads.some(
            (upload: { key: string; playedSamples: number }) =>
              upload.playedSamples > 0 &&
              upload.playedSamples / 24 < playedDurationMs &&
              Object.values(attachments).some((a) => a.key === upload.key),
          ),
        ).toBe(true);
        for (const name of ["assistant_turn", "livekit.agent_speaking"]) {
          const owner = findLatestSpan(events, name)!;
          const selections = owner.row.metadata?.["audio.selections"] as {
            recording_id: string;
            recording_span_id: string;
            channel_index: number;
            start_offset_ms: number;
            end_offset_ms: number;
          }[];
          expect(selections.map((s) => s.recording_id)).toEqual(
            descriptors.map((r) => r.id),
          );
          let selectedMs = 0;
          let previousEnd: number | undefined;
          for (const selection of selections) {
            const recording = descriptors.find(
              (r) => r.id === selection.recording_id,
            )!;
            expect(selection.recording_span_id).toBe(root.span.id);
            expect(selection.channel_index).toBe(1);
            expect(selection.start_offset_ms).toBeGreaterThanOrEqual(0);
            expect(selection.end_offset_ms).toBeGreaterThan(
              selection.start_offset_ms,
            );
            expect(selection.end_offset_ms).toBeLessThanOrEqual(
              recording.duration_ms + 0.05,
            );
            const start =
              recording.timeline.recording_start_offset_ms +
              selection.start_offset_ms;
            if (previousEnd !== undefined)
              expect(start).toBeCloseTo(previousEnd, 1);
            previousEnd =
              recording.timeline.recording_start_offset_ms +
              selection.end_offset_ms;
            selectedMs += selection.end_offset_ms - selection.start_offset_ms;
          }
          expect(selectedMs).toBeCloseTo(playedDurationMs, 1);
        }
      });
    },
    120000,
  );
}

// Keep setup failures here; real cascade/realtime replays below cover explicit Ogg.
for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  for (const mode of [
    "off",
    "wav",
    "unsampled",
    "redacted",
    "missing",
    "missing-wav",
    "integration-off",
    "worker",
    "fork",
    "env",
    "defaults",
  ]) {
    test.sequential(
      `${variant} automatic setup ${mode}`,
      async () => {
        await withScenarioHarness(async (harness) => {
          await harness.runNodeScenarioDir({
            scenarioDir,
            entry: ["worker", "fork"].includes(mode)
              ? "worker.mjs"
              : "automatic.mjs",
            timeoutMs: 60000,
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            env: {
              LIVEKIT_PACKAGE: variant,
              LIVEKIT_AUTO_MODE: mode,
              NODE_PATH: "",
              BRAINTRUST_CAPTURE_ATTACHMENTS: "true",
              BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS:
                mode === "env" ? "true" : "",
              BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS:
                mode === "env" ? "true" : "",
            },
            runContext: {
              variantKey: variant,
              originalScenarioDir,
              cassette: false,
            },
          });
          const events = harness.events();
          assertAudioTrace(events);
          if (mode === "integration-off" || mode === "unsampled") {
            expect(events).toHaveLength(0);
            return;
          }
          const roots = findAllSpans(events, "livekit.agent_session");
          expect(roots).toHaveLength(1);
          const root = roots[0];
          const metadata = root.row.metadata as
            | Record<string, unknown>
            | undefined;
          if (mode === "wav" || mode === "env") {
            // Verify wire ordering, not just the final merged trace.
            const requests = harness.requestsAfter(0);
            const uploaded = requests.findIndex(
              (r) =>
                r.path === "/attachment/status" &&
                (r.jsonBody as { status?: { upload_status?: string } })?.status
                  ?.upload_status === "done",
            );
            const ready = requests.findIndex((r) => {
              if (r.path !== "/logs3") return false;
              const body = r.jsonBody as {
                rows?: {
                  metadata?: { "audio.recordings"?: { state: string }[] };
                }[];
              };
              return body.rows?.some((row) =>
                row.metadata?.["audio.recordings"]?.some(
                  (s) => s.state === "ready",
                ),
              );
            });
            expect(uploaded).toBeGreaterThanOrEqual(0);
            expect(ready).toBeGreaterThan(uploaded);
            expect(metadata?.["audio.recordings"]).toMatchObject([
              {
                state: "ready",
                mime_type: mode === "wav" ? "audio/wav" : "audio/ogg",
              },
            ]);
          } else expect(metadata?.["audio.recordings"]).toBeUndefined();
          const turn = findLatestSpan(events, "assistant_turn");
          expect(turn).toBeDefined();
          if (mode === "redacted")
            expect(JSON.stringify(events.map((e) => e.row))).not.toContain(
              "Your order arrives Friday.",
            );
          else
            expect(JSON.stringify(turn?.row.output)).toContain(
              "Your order arrives Friday.",
            );
        });
      },
      90000,
    );
  }
}

for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  for (const realtime of [false, true]) {
    test.sequential(
      `${variant} automatic ${realtime ? "realtime" : "cascade"} conversation`,
      async () => {
        await withScenarioHarness(async (harness) => {
          await harness.runNodeScenarioDir({
            scenarioDir,
            entry: "scenario.mjs",
            timeoutMs: 90000,
            nodeArgs: ["--import", "braintrust/hook.mjs"],
            env: {
              LIVEKIT_PACKAGE: variant,
              LIVEKIT_AUTOMATIC: "1",
              LIVEKIT_PROVIDER: "1",
              LIVEKIT_AUDIO: "1",
              LIVEKIT_REALTIME: realtime ? "1" : "0",
              LIVEKIT_WS_PATH: `${originalScenarioDir}/__cassettes__/${variant}-realtime.websocket.json`,
            },
            runContext: {
              variantKey: variant,
              originalScenarioDir,
              cassette: {
                variantKey: `${variant}-${realtime ? "realtime" : "order"}`,
              },
            },
          });
          const events = harness.events();
          assertAudioTrace(events);
          expect(findAllSpans(events, "livekit.agent_session")).toHaveLength(1);
          const turns = findAllSpans(events, "assistant_turn");
          const turnIds = new Set(turns.map((t) => t.span.id));
          for (const response of findAllSpans(events, "llm_response"))
            expect(
              turnIds.has(
                (response.row.span_parents as string[] | undefined)?.[0],
              ),
            ).toBe(true);
          expect(
            turns.some((t) => {
              const metadata = t.row.metadata as
                | Record<string, unknown>
                | undefined;
              const selections = metadata?.["audio.selections"];
              return Array.isArray(selections) && selections.length > 0;
            }),
          ).toBe(true);
          expect(findAllSpans(events, "lookup_order")).toHaveLength(1);
          expect(findAllSpans(events, "llm_response").length).toBeGreaterThan(
            0,
          );
          expect(
            findLatestSpan(events, "livekit.agent_session")?.row,
          ).toMatchObject({
            metadata: {
              "audio.recordings": [{ state: "ready", mime_type: "audio/ogg" }],
            },
          });
          expect(
            JSON.stringify(
              findLatestSpan(events, "assistant_turn")?.row.output,
            ),
          ).toContain("Friday");
        });
      },
      120000,
    );
  }
}
