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
      /(_ms|_at|At|wait_duration|queue_wait|playback_latency|playbackPosition|ttft|ttfb|time_to_first_chunk|time_to_first_token|timestamp|ttfbMs|durationMs|tokensPerSecond)$/.test(
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
          k.startsWith("item_") ? stable(k) : k,
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
  test.sequential(
    `${variant} realtime order conversation`,
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
            LIVEKIT_REALTIME: "1",
            LIVEKIT_AUDIO: "1",
            LIVEKIT_WS_PATH: `${originalScenarioDir}/__cassettes__/${variant}-realtime.websocket.json`,
            BRAINTRUST_E2E_CASSETTE_MODE:
              process.env.BRAINTRUST_E2E_CASSETTE_MODE ?? "replay",
            BRAINTRUST_DISABLE_INSTRUMENTATION: "",
            OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "replay",
          },
          runContext: {
            variantKey: variant,
            originalScenarioDir,
            cassette: false,
          },
        });
        const stable = normalizer();
        const raw = harness.events();
        const events = [...new Set(raw.map((e) => e.span.name))].flatMap(
          (name) => findAllSpans(raw, name!),
        );
        expect(
          findLatestSpan(events, "lookup_order")?.row.output,
        ).toMatchObject({ delivery: "Friday" });
        expect(
          events.filter((e) => e.span.name === "llm_response"),
        ).toHaveLength(2);
        const turn = findLatestSpan(events, "assistant_turn");
        expect(turn?.row.output).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: expect.stringMatching(/Friday/i),
            }),
          ]),
        );
        const user = events.find(
          (e) =>
            e.span.name === "user_turn" && e.row.metadata?.["openai.item_id"],
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
        expect(turn?.row.metadata?.["turn.reply_to"]).toBe(user!.span.id);
        const speaking = findLatestSpan(events, "livekit.user_speaking");
        expect(speaking?.row.span_parents).toEqual([user!.span.id]);
        expect(speaking?.row.metadata?.["turn.id"]).toBe(user!.span.id);
        expect(speaking?.row.metadata?.["audio.selections"]).toEqual(
          user!.row.metadata?.["audio.selections"],
        );
        expect(
          events
            .filter((e) => e.span.name === "llm_response")
            .every((e) => Array.isArray(e.row.output)),
        ).toBe(true);
        expect(findLatestSpan(events, "tts")).toBeUndefined();
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
            `${variant}-realtime.span-tree.json`,
          ),
        );
      });
    },
    120000,
  );
}

for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  test.sequential(
    `${variant} interrupted order answer`,
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
            BRAINTRUST_DISABLE_INSTRUMENTATION: "",
          },
          runContext: {
            variantKey: variant,
            cassette: { variantKey: `${variant}-order` },
            originalScenarioDir,
          },
        });
        const raw = harness.events();
        const events = [...new Set(raw.map((e) => e.span.name))].flatMap(
          (name) => findAllSpans(raw, name!),
        );
        const turn = findLatestSpan(events, "assistant_turn");
        expect(turn?.row.metadata?.["contrib.livekit.interrupted"]).toBe(true);
        expect(turn?.row.metadata?.["audio.selections"]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ channel_index: 1 }),
          ]),
        );
        expect(turn?.row.metadata?.["contrib.livekit.playback_events"]).toEqual(
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
            `${variant}-interrupted.span-tree.json`,
          ),
        );
      });
    },
    120000,
  );
}

for (const variant of ["livekit-v1", "livekit-v1-latest"]) {
  test.sequential(
    `${variant} progressive Ogg order recording`,
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
            LIVEKIT_SEGMENTS: "1",
            BRAINTRUST_DISABLE_INSTRUMENTATION: "",
          },
          runContext: {
            variantKey: variant,
            cassette: { variantKey: `${variant}-order` },
            originalScenarioDir,
          },
        });
        const raw = harness.events();
        const events = [...new Set(raw.map((e) => e.span.name))].flatMap(
          (name) => findAllSpans(raw, name!),
        );
        const root = findLatestSpan(events, "livekit.agent_session")!;
        const descriptors = root.row.metadata?.["audio.recordings"] as {
          id: string;
          state: string;
          mime_type: string;
          recording_group_id: string;
        }[];
        expect(descriptors.length).toBeGreaterThan(1);
        expect(
          descriptors.every(
            (r) =>
              r.state === "ready" &&
              r.mime_type === "audio/ogg" &&
              r.recording_group_id === "call",
          ),
        ).toBe(true);
        const turn = findLatestSpan(events, "assistant_turn")!;
        expect(
          new Set(
            (
              turn.row.metadata?.["audio.selections"] as {
                recording_id: string;
              }[]
            ).map((s) => s.recording_id),
          ).size,
        ).toBeGreaterThan(1);
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
            `${variant}-segments.span-tree.json`,
          ),
        );
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
