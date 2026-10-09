/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Capture, Packet } from "./runtime";
const MAX_PACKETS = 100000;
export function omit(c: Capture, reason: string) {
  c.recording.stop(reason);
}
export function release(c: Capture) {
  c.inputStream = undefined;
}
export function advance(c: Capture) {
  const wall = Date.now() - c.origin - 1000;
  c.recording.advance(
    Math.min(
      wall,
      c.user ? (c.inputEnd ?? 0) : wall,
      ...c.outputHolds.values(),
    ),
  );
}
export function copyFrame(c: Capture, frame: any): Int16Array | undefined {
  if (c.closed || c.recording.reason) return;
  if (
    !(frame?.data instanceof Int16Array) ||
    !Number.isInteger(frame.sampleRate) ||
    frame.sampleRate < 8000 ||
    frame.sampleRate > 96000 ||
    ![1, 2].includes(frame.channels) ||
    frame.data.length % frame.channels
  ) {
    omit(c, "unsupported_frame_format");
    return;
  }
  if (!frame.data.length) return;
  return c.recording.copy(frame.data);
}
export function packet(c: Capture, p: Packet): boolean {
  return c.recording.append(p);
}
export function select(
  c: Capture,
  owner: string | undefined,
  start: number,
  end: number,
  channel: number,
) {
  if (!owner || !(end > start)) return;
  const list = c.selections.get(owner) ?? [];
  const previous = list.at(-1);
  if (
    previous &&
    previous.channel_index === channel &&
    start >= previous.start_offset_ms &&
    start <= previous.end_offset_ms + 1 / 24
  ) {
    previous.end_offset_ms = Math.max(previous.end_offset_ms, end);
    return;
  }
  if (list.length >= MAX_PACKETS) {
    omit(c, "selection_limit");
    return;
  }
  list.push({
    recording_span_id: c.row.span.spanId,
    recording_id: "call",
    start_offset_ms: start,
    end_offset_ms: end,
    channel_index: channel,
  });
  c.selections.set(owner, list);
}
