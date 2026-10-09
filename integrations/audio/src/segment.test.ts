import { expect, test } from "vitest";
import { AudioSegment } from "./segment";

const encoded = {
  durationMs: 20,
  sampleRate: 24000,
  mimeType: "audio/wav",
};
function segment() {
  return new AudioSegment("call-0000", 40, 60, [
    { pcm: new Int16Array(480), at: 0, rate: 24000, channels: 1, channel: 0 },
  ]);
}
test("segment becomes ready only after encoding and upload, retaining its descriptor", () => {
  const s = segment();
  expect(() => s.dispatch({ type: "ready", reference: "uploaded" })).toThrow();
  const packets = s.dispatch({ type: "encode" });
  expect(packets[0].pcm).toHaveLength(480);
  expect(() => s.dispatch({ type: "encode" })).toThrow();
  s.dispatch({ type: "encoded", format: encoded });
  expect(s.state).toBe("pending");
  s.dispatch({ type: "ready", reference: "uploaded" });
  expect(s).toMatchObject({
    id: "call-0000",
    start: 40,
    end: 60,
    state: "ready",
    channels: [0],
    ...encoded,
    attachmentReference: "uploaded",
  });
  expect(() => s.dispatch({ type: "encoded", format: encoded })).toThrow();
  expect(() =>
    s.dispatch({ type: "omitted", reason: "late_failure" }),
  ).toThrow();
  expect(s.state).toBe("ready");
});
test.each(["queued", "encoding", "uploading"])(
  "omission during %s is terminal and preserves its original reason",
  (phase) => {
    const s = segment();
    if (phase !== "queued") {
      s.dispatch({ type: "encode" });
    }
    if (phase === "uploading") {
      s.dispatch({ type: "encoded", format: encoded });
    }
    s.dispatch({ type: "omitted", reason: "failed" });
    expect(s).toMatchObject({ state: "omitted", reason: "failed" });
    expect(() => s.dispatch({ type: "ready", reference: "late" })).toThrow();
    expect(() => s.dispatch({ type: "encoded", format: encoded })).toThrow();
    expect(() => s.dispatch({ type: "omitted", reason: "other" })).toThrow();
    expect(s.reason).toBe("failed");
  },
);
