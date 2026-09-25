import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, afterEach, expect, it } from "vitest";
import { registry } from "../registry";
import { configureNode } from "../../node/config";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { TwilioRealtimePlugin } from "./twilio-realtime-plugin";
import {
  twilioRealtimeChannels,
  realtimeSendChannels,
} from "./twilio-realtime-channels";
configureNode();
let plugin: TwilioRealtimePlugin;
let logger: ReturnType<typeof _exportsForTestingOnly.useTestBackgroundLogger>;
beforeAll(() => _exportsForTestingOnly.simulateLoginForTests());
beforeEach(() => {
  logger = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({ projectName: "twilio-unit", projectId: "test-project-id" });
  registry.disable();
  plugin = new TwilioRealtimePlugin();
  plugin.enable();
});
afterEach(() => {
  plugin.disable();
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

// Synthetic protocol events exercise instrumentation only, not provider behavior.
it("keeps concurrent adapter sessions separate and finalizes metadata without audio opt-in", async () => {
  const transports: any[] = [new EventEmitter(), new EventEmitter()];
  for (const [i, t] of transports.entries()) {
    t.status = "connected";
    t.currentItemId = `a${i}`;
    await twilioRealtimeChannels.connect.invoke(async () => {}, t, [], {});
    t.emit("*", {
      type: "twilio_message",
      message: {
        event: "start",
        start: {
          streamSid: `s${i}`,
          mediaFormat: {
            encoding: "audio/x-mulaw",
            sampleRate: 8000,
            channels: 1,
          },
        },
      },
    });
    const audio = Buffer.alloc(160, 255).toString("base64");
    t.emit("*", {
      type: "twilio_message",
      message: {
        event: "media",
        media: { track: "inbound", timestamp: "0", payload: audio },
      },
    });
    realtimeSendChannels.send.invoke(
      () => {},
      t,
      [{ type: "input_audio_buffer.append", audio }],
      {},
    );
    t.emit("*", {
      type: "input_audio_buffer.speech_started",
      item_id: `u${i}`,
      audio_start_ms: 0,
    });
    t.emit("*", {
      type: "input_audio_buffer.speech_stopped",
      item_id: `u${i}`,
      audio_end_ms: 20,
    });
    t.emit("*", { type: "response.created", response: { id: `r${i}` } });
    t.emit("*", {
      type: "response.output_audio.delta",
      response_id: `r${i}`,
      delta: audio,
    });
    t.emit("audio", { data: new Uint8Array(160).fill(255).buffer });
  }
  transports[1].emit("connection_change", "disconnected");
  transports[0].emit("connection_change", "disconnected");
  const raw = (await logger.drain()) as any[];
  const merged = new Map<string, any>();
  for (const r of raw) {
    const old = merged.get(r.id) || {};
    merged.set(r.id, {
      ...old,
      ...r,
      metadata: { ...old.metadata, ...r.metadata },
      metrics: { ...old.metrics, ...r.metrics },
    });
  }
  const rows = [...merged.values()];
  const sessions = rows.filter(
    (r) => r.span_attributes?.name === "voice_session",
  );
  expect(sessions).toHaveLength(2);
  for (const [i, session] of sessions.entries()) {
    const children = rows.filter(
      (r) => r.root_span_id === session.root_span_id,
    );
    const audio = children.filter(
      (r) => r.span_attributes?.name === "user_audio",
    );
    expect(audio).toHaveLength(1);
    expect(audio[0].metadata["audio.track.id"]).toBe(`s${i}:caller`);
    expect(audio[0].metadata["audio.end_offset_ms"]).toBe(20);
    expect(audio[0].input?.audio).toBeUndefined();
  }
  expect(transports.every((t) => t.listenerCount("*") === 0)).toBe(true);
});

it("preserves connection failure and ends the auto-created session", async () => {
  const t = new EventEmitter();
  const error = new Error("connection failed");
  await expect(
    twilioRealtimeChannels.connect.invoke(
      async () => {
        throw error;
      },
      t,
      [],
      {},
    ),
  ).rejects.toBe(error);
  const raw = (await logger.drain()) as any[];
  const merged = new Map<string, any>();
  for (const r of raw) {
    const old = merged.get(r.id) || {};
    merged.set(r.id, {
      ...old,
      ...r,
      metadata: { ...old.metadata, ...r.metadata },
      metrics: { ...old.metrics, ...r.metrics },
    });
  }
  const rows = [...merged.values()];
  expect(
    rows.find((r) => r.span_attributes?.name === "voice_session")?.metrics.end,
  ).toBeTypeOf("number");
  expect(t.listenerCount("*")).toBe(0);
});
