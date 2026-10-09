import { parentPort } from "node:worker_threads";
import { encodeCall, pcmChunks } from "./pcm";
import type { Packet } from "./recorder";
parentPort?.on(
  "message",
  async ({
    packets,
    durationMs,
    encoderModule,
  }: {
    packets: Packet[];
    durationMs: number;
    encoderModule?: string;
  }) => {
    try {
      const codec = encoderModule ? await import(encoderModule) : undefined;
      if (codec?.encodeChunks) {
        // The optional codec preserves resampling history between PCM blocks.
        const encoded = await codec.encodeChunks(
          pcmChunks(packets, durationMs),
          24000,
          2,
        );
        parentPort!.postMessage(
          { ...encoded, durationMs: Math.round(durationMs * 24) / 24 },
          [encoded.bytes.buffer],
        );
      } else {
        // Preserve compatibility with codecs exposing the original encode API.
        const result = encodeCall(packets, durationMs);
        const encoded = codec
          ? await codec.encode(
              new Int16Array(result.bytes.buffer, 44),
              24000,
              2,
            )
          : { bytes: result.bytes, mimeType: "audio/wav", sampleRate: 24000 };
        parentPort!.postMessage({ ...encoded, durationMs: result.durationMs }, [
          encoded.bytes.buffer,
        ]);
      }
    } catch {
      parentPort!.postMessage({ reason: "encoding_failed" });
    }
  },
);
