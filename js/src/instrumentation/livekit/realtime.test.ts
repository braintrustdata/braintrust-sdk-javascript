import * as timeline from "../../../../integrations/audio/src/timeline";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { RealtimeObserver } from "./realtime";
import type { Capture } from "./runtime";
function fixture(content = true) {
  const logs: any[] = [];
  const turns: any[] = [];
  const root: any = {
    spanId: "root",
    log: (data: any) => logs.push(data),
    startSpan: (args: any) => {
      const row = {
        spanId: `user-${turns.length}`,
        args,
        logs: [] as any[],
        ended: false,
        log(data: any) {
          this.logs.push(data);
        },
        end() {
          this.ended = true;
        },
      };
      turns.push(row);
      return row;
    },
  };
  const session = new EventEmitter();
  const c = {
    user: true,
    row: { span: root },
    inputTimeline: [
      { at: 100, duration: 1000, rate: 24000, channels: 1, sampleStart: 0 },
    ],
    selections: new Map(),
    timeline,
  } as unknown as Capture;
  const observer = new RealtimeObserver(session, root, content, () => c);
  const send = (event: any) =>
    session.emit("openai_client_event_queued", event);
  const receive = (event: any) =>
    session.emit("openai_server_event_received", event);
  return { c, observer, send, receive, turns, session };
}
test("server item identity associates late transcripts, replies and exact retained input ranges", () => {
  const { c, observer, send, receive, turns, session } = fixture();
  send({
    type: "input_audio_buffer.append",
    audio: Buffer.alloc(48000).toString("base64"),
  });
  receive({
    type: "input_audio_buffer.speech_started",
    item_id: "input-1",
    audio_start_ms: 200,
  });
  receive({
    type: "input_audio_buffer.speech_stopped",
    item_id: "input-1",
    audio_end_ms: 500,
  });
  receive({ type: "response.created", response: { id: "response-1" } });
  receive({
    type: "input_audio_buffer.speech_started",
    item_id: "input-2",
    audio_start_ms: 600,
  });
  receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input-1",
    transcript: "Where is order 1042?",
  });
  const model: any = {
    logs: [],
    log(data: any) {
      this.logs.push(data);
    },
  };
  observer.bind("response-1", model);
  expect(model.logs).toContainEqual({
    metadata: { "turn.reply_to": "user-0" },
  });
  expect(turns[0].logs).toContainEqual({
    input: [{ role: "user", content: "Where is order 1042?" }],
  });
  expect(model.logs).toContainEqual({
    input: [{ role: "user", content: "Where is order 1042?" }],
    metadata: { "contrib.livekit.input_scope": "associated_user_turn" },
  });
  expect(c.selections.get("user-0")).toMatchObject([
    { start_offset_ms: 300, end_offset_ms: 600, channel_index: 0 },
  ]);
  observer.close();
  expect(turns[1].logs).toContainEqual({
    metadata: { "turn.incomplete": true },
  });
  expect(session.listenerCount("openai_server_event_received")).toBe(0);
});
test("late transcripts update only their associated model responses", () => {
  const { observer, receive } = fixture();
  const models = [[], []] as any[][];
  for (let i = 0; i < 2; i++) {
    receive({ type: "input_audio_buffer.speech_started", item_id: `u${i}` });
    receive({ type: "input_audio_buffer.speech_stopped", item_id: `u${i}` });
    receive({ type: "response.created", response: { id: `r${i}` } });
    observer.bind(`r${i}`, {
      log: (value: any) => models[i].push(value),
    } as any);
  }
  for (const i of [1, 0])
    receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: `u${i}`,
      transcript: `caller ${i}`,
    });
  expect(models.map((logs) => logs.flatMap((row) => row.input ?? []))).toEqual([
    [{ role: "user", content: "caller 0" }],
    [{ role: "user", content: "caller 1" }],
  ]);
  observer.close();
});

test("speaking ownership is single-use and expires after the provider dispatch", async () => {
  const { observer, receive, turns } = fixture();
  receive({ type: "input_audio_buffer.speech_started", item_id: "first" });
  expect(observer.takeSpeakingTurn()).toBe(turns[0]);
  expect(observer.takeSpeakingTurn()).toBeUndefined();
  receive({ type: "input_audio_buffer.speech_started", item_id: "first" });
  expect(observer.takeSpeakingTurn()).toBeUndefined();
  receive({ type: "input_audio_buffer.speech_started", item_id: "second" });
  await Promise.resolve();
  expect(observer.takeSpeakingTurn()).toBeUndefined();
  receive({ type: "input_audio_buffer.speech_started", item_id: "third" });
  receive({ type: "input_audio_buffer.speech_stopped", item_id: "third" });
  expect(observer.takeSpeakingTurn()).toBeUndefined();
  receive({ type: "input_audio_buffer.speech_started", item_id: "fourth" });
  receive({ type: "error" });
  expect(observer.takeSpeakingTurn()).toBeUndefined();
  receive({ type: "input_audio_buffer.speech_started", item_id: "fifth" });
  receive({ type: "session.created" });
  expect(observer.takeSpeakingTurn()).toBeUndefined();
  receive({ type: "input_audio_buffer.speech_started", item_id: "sixth" });
  observer.close();
  expect(observer.takeSpeakingTurn()).toBeUndefined();
});
test("clears invalidate later alignment and content opt-out keeps transcripts private", () => {
  const { c, observer, send, receive, turns } = fixture(false);
  send({
    type: "input_audio_buffer.append",
    audio: Buffer.alloc(48000).toString("base64"),
  });
  send({ type: "input_audio_buffer.clear" });
  receive({
    type: "input_audio_buffer.speech_started",
    item_id: "input",
    audio_start_ms: 200,
  });
  receive({
    type: "input_audio_buffer.speech_stopped",
    item_id: "input",
    audio_end_ms: 500,
  });
  receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input",
    transcript: "private",
  });
  expect(c.selections.size).toBe(0);
  expect(JSON.stringify(turns)).not.toContain("private");
  observer.close();
});

test("an unsolicited response does not inherit a historical caller turn", () => {
  const { observer, receive } = fixture();
  receive({
    type: "input_audio_buffer.speech_started",
    item_id: "input",
    audio_start_ms: 0,
  });
  receive({
    type: "input_audio_buffer.speech_stopped",
    item_id: "input",
    audio_end_ms: 500,
  });
  receive({ type: "response.created", response: { id: "answer" } });
  receive({ type: "response.created", response: { id: "unsolicited" } });
  const logs: any[] = [];
  const span: any = { log: (data: any) => logs.push(data) };
  observer.bind("unsolicited", span);
  expect(logs.some((log) => log.metadata?.["turn.reply_to"])).toBe(false);
  observer.close();
});

test("recording opt-out never inspects inline provider audio", () => {
  const { c, observer, send } = fixture();
  c.user = false;
  let inspected = false;
  send({
    type: "input_audio_buffer.append",
    get audio() {
      inspected = true;
      return "AAAA";
    },
  });
  expect(inspected).toBe(false);
  observer.close();
});

test("provider errors invalidate alignment while retaining unhandled error semantics", () => {
  const { c, observer, session, send, receive } = fixture();
  expect(() => session.emit("error", new Error("provider failure"))).toThrow(
    "provider failure",
  );
  send({
    type: "input_audio_buffer.append",
    audio: Buffer.alloc(48000).toString("base64"),
  });
  receive({
    type: "input_audio_buffer.speech_started",
    item_id: "after-error",
    audio_start_ms: 0,
  });
  receive({
    type: "input_audio_buffer.speech_stopped",
    item_id: "after-error",
    audio_end_ms: 500,
  });
  expect(c.selections.size).toBe(0);
  observer.close();
});

test("response association is independent of model binding order", () => {
  const { observer, receive } = fixture();
  const logs: any[] = [];
  const model: any = { log: (event: any) => logs.push(event) };
  receive({
    type: "input_audio_buffer.speech_started",
    item_id: "caller",
    audio_start_ms: 0,
  });
  receive({
    type: "input_audio_buffer.speech_stopped",
    item_id: "caller",
    audio_end_ms: 100,
  });
  observer.bind("reply", model);
  receive({ type: "response.created", response: { id: "reply" } });
  expect(logs).toContainEqual({ metadata: { "turn.reply_to": "user-0" } });
  observer.close();
});
