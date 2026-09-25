import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { instrumentTwilioRealtime } from "./index";
import type { Span } from "../../logger";

class Socket extends EventEmitter {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  receive(event: object) {
    this.emit("message", JSON.stringify(event));
  }
}
function fixture(options: Record<string, unknown> = {}) {
  const rows: any[] = [];
  function span(name = "session", parent?: string): any {
    const row = { name, spanId: String(rows.length), parent, metadata: {} };
    rows.push(row);
    return {
      spanId: row.spanId,
      log(event: any) {
        Object.assign(row, {
          ...event,
          metadata: { ...row.metadata, ...event.metadata },
        });
      },
      startSpan(args: any) {
        const child = span(args.name, row.spanId);
        child.log(args.event ?? {});
        return child;
      },
      end() {},
    };
  }
  const twilio = new Socket(),
    realtime = new Socket();
  let time = 0;
  const observer = instrumentTwilioRealtime({
    twilio,
    realtime,
    span: span() as Span,
    now: () => time,
    ...options,
  });
  twilio.receive({
    event: "start",
    start: {
      streamSid: "s",
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    },
  });
  const input = (start: number, duration = 20) => {
    time = start;
    const payload = Buffer.alloc(duration * 8, 255).toString("base64");
    twilio.receive({
      event: "media",
      media: { track: "inbound", timestamp: String(start), payload },
    });
    realtime.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: payload }),
    );
  };
  return {
    rows,
    twilio,
    realtime,
    observer,
    input,
    time: (t: number) => {
      time = t;
    },
  };
}
describe("Twilio / Realtime protocol instrumentation", () => {
  it("maps VAD sample clocks across a capture gap and keeps audio segments separate", () => {
    const f = fixture();
    f.input(100);
    f.input(120);
    f.input(200);
    f.realtime.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "u",
      audio_start_ms: 20,
    });
    f.realtime.receive({
      type: "input_audio_buffer.speech_stopped",
      item_id: "u",
      audio_end_ms: 60,
    });
    f.realtime.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u",
      transcript: "hello",
    });
    f.observer.finish();
    expect(
      f.rows
        .filter((r) => r.name === "user_audio")
        .map((r) => [
          r.metadata["audio.start_offset_ms"],
          r.metadata["audio.end_offset_ms"],
        ]),
    ).toEqual([
      [100, 140],
      [200, 220],
    ]);
    expect(
      f.rows.find((r) => r.name === "audio.capture.gap").metadata,
    ).toMatchObject({
      "audio.start_offset_ms": 140,
      "audio.end_offset_ms": 200,
    });
    const voice = f.rows.find((r) => r.name === "user_speaking");
    expect(voice.metadata).toMatchObject({
      "voice.start_offset_ms": 120,
      "voice.end_offset_ms": 220,
    });
    expect(voice.input).toEqual([{ role: "user", content: "hello" }]);
    expect(f.rows.some((r) => r.metadata["audio.ref"])).toBe(false);
  });
  it("uses the correct side of a discontinuity for start and end boundaries", () => {
    const f = fixture();
    f.input(0);
    f.input(100);
    f.realtime.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "before",
      audio_start_ms: 0,
    });
    f.realtime.receive({
      type: "input_audio_buffer.speech_stopped",
      item_id: "before",
      audio_end_ms: 20,
    });
    f.realtime.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "after",
      audio_start_ms: 20,
    });
    f.realtime.receive({
      type: "input_audio_buffer.speech_stopped",
      item_id: "after",
      audio_end_ms: 40,
    });
    f.observer.finish();
    const voices = f.rows.filter((r) => r.name === "user_speaking");
    expect(voices[0].metadata["voice.end_offset_ms"]).toBe(20);
    expect(voices[1].metadata["voice.start_offset_ms"]).toBe(100);
    expect(voices[1].metadata["voice.end_offset_ms"]).toBe(120);
  });
  it("captures sent audio only and never treats clear/mark as a playback cutoff", async () => {
    const f = fixture({ retainAudio: true });
    f.input(0);
    f.realtime.receive({ type: "response.created", response: { id: "r" } });
    f.realtime.receive({
      type: "response.output_audio.delta",
      response_id: "r",
      delta: Buffer.alloc(8000).toString("base64"),
    });
    f.time(100);
    f.twilio.send(
      JSON.stringify({
        event: "media",
        media: { payload: Buffer.alloc(160, 255).toString("base64") },
      }),
    );
    f.twilio.send(JSON.stringify({ event: "clear" }));
    f.twilio.receive({ event: "mark", mark: { name: "discarded" } });
    f.observer.finish();
    f.observer.finish();
    const audio = f.rows.filter((r) => r.name === "agent_audio");
    expect(audio).toHaveLength(1);
    expect(audio[0].metadata).toMatchObject({
      "audio.capture": "sent",
      "audio.start_offset_ms": 100,
      "audio.end_offset_ms": 120,
    });
    expect(audio[0].metadata["audio.clip_end_ms"]).toBeUndefined();
    const blob = await audio[0].input.audio.data();
    const bytes = Buffer.from(await blob.arrayBuffer());
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.readUInt32LE(40)).toBe(320);
    expect(bytes.readInt16LE(44)).toBe(0);
  });
  it("drops a partial retained segment when reaching its cap, preserving metadata", () => {
    const f = fixture({ retainAudio: true, maxAudioBytes: 160 });
    f.input(0);
    f.input(20);
    f.observer.finish();
    const audio = f.rows.find((r) => r.name === "user_audio");
    expect(audio.metadata["audio.end_offset_ms"]).toBe(40);
    expect(audio.metadata["audio.ref"]).toBeUndefined();
    expect(
      f.rows.filter((r) => r.name === "audio.retention.limit"),
    ).toHaveLength(1);
  });
  it("does not invent end offsets for unfinished VAD and isolates malformed input", () => {
    const f = fixture();
    f.input(0);
    f.realtime.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "u",
      audio_start_ms: 0,
    });
    f.twilio.emit("message", "bad JSON");
    f.observer.finish();
    expect(
      f.rows.find((r) => r.name === "user_speaking").metadata[
        "voice.end_offset_ms"
      ],
    ).toBeUndefined();
    expect(
      f.rows.filter((r) => r.name === "audio.instrumentation.error"),
    ).toHaveLength(1);
  });
});
