import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Also run this file from an isolated app installed from `pnpm pack` output.
const require = createRequire(import.meta.url);
for (const api of [
  await import("@braintrust/audio"),
  require("@braintrust/audio"),
]) {
  for (const audioFormat of ["wav", "ogg"]) {
    const rows = [];
    const files = [];
    const recording = api.createRecording({
      audioFormat,
      span: { spanId: "session", log: (row) => rows.push(row) },
      flush: async () => {},
      createAttachment: ({ data, filename, contentType }) => {
        files.push(data);
        return {
          reference: { key: filename, filename, content_type: contentType },
          upload: async () => ({ upload_status: "done" }),
        };
      },
      snapshot: () => ({
        origin: 1000,
        basis: "test",

        source: (channel_index) => ({ channel_index }),
      }),
      turnSelections: () => [],
    });
    recording.record({
      pcm: new Int16Array(480).fill(1000),
      at: 0,
      rate: 24000,
      channels: 1,
      channel: 0,
    });
    await recording.finish();
    assert.equal(files.length, 1);
    assert.equal(
      Buffer.from(files[0].subarray(0, 4)).toString(),
      audioFormat === "wav" ? "RIFF" : "OggS",
    );
    assert.equal(
      rows.flatMap((r) => r.metadata?.["audio.recordings"] ?? []).at(-1).state,
      "ready",
    );
  }
}
console.log("WAV and Ogg recording passed through ESM and CommonJS exports.");
