/**
 * The wire a room speaks to an agent.
 *
 * A deliberately small JSON framing, shaped after Twilio Media Streams
 * (`event` plus a base64 `payload`) so the demo exercises the same
 * client/server split a real media-stream adapter would, without pulling in a
 * codec. A real adapter would speak the vendor's exact protocol; this is the
 * seam where that lives.
 */

import { AudioFrame } from "./types";

export type WireFrame =
  | { event: "start"; direction: "inbound" | "outbound" }
  | { event: "text"; text: string }
  | { event: "media"; payload: string; sampleRate: number }
  | { event: "hangup" };

export function encode(frame: WireFrame): string {
  return JSON.stringify(frame);
}

export function decode(raw: string | Buffer): WireFrame | null {
  try {
    const parsed = JSON.parse(raw.toString());
    return typeof parsed?.event === "string" ? (parsed as WireFrame) : null;
  } catch {
    return null;
  }
}

export function frameToPayload(frame: AudioFrame): string {
  return Buffer.from(
    frame.data.buffer,
    frame.data.byteOffset,
    frame.data.byteLength,
  ).toString("base64");
}

export function payloadToFrame(
  payload: string,
  sampleRate: number,
): AudioFrame {
  const buf = Buffer.from(payload, "base64");
  return {
    data: new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2),
    sampleRate,
    numChannels: 1,
  };
}
