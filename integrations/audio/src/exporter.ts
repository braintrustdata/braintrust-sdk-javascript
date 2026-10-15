import { AudioSegment, type Packet, type EncodedAudio } from "./segment";

export type Encoder = (
  packets: Packet[],
  durationMs: number,
) => Promise<EncodedAudio>;
export type CreateAttachment = (options: {
  data: Uint8Array;
  filename: string;
  contentType: string;
}) => {
  upload(): Promise<{ upload_status: string; error_message?: string }>;
  reference: unknown;
};

/** Executes a sealed segment; recording policy and trace publication stay with callers. */
export class SegmentExporter {
  constructor(
    private encode: Encoder,
    private createAttachment: CreateAttachment,
  ) {}

  async export(
    segment: AudioSegment,
    release: (pcm: Int16Array) => void,
  ): Promise<void> {
    const packets = segment.dispatch({ type: "encode" });
    let data: EncodedAudio;
    try {
      data = await this.encode(packets, segment.end - segment.start);
      segment.dispatch({ type: "encoded", format: data });
    } catch (error) {
      segment.dispatch({
        type: "omitted",
        reason: error instanceof Error ? error.message : "encoding_failed",
      });
      return;
    } finally {
      // Release source memory only after the worker has finished with it.
      for (const packet of packets) {
        release(packet.pcm);
      }
      packets.length = 0;
    }

    try {
      const attachment = this.createAttachment({
        data: data.bytes,
        filename: `${segment.id}.${data.mimeType === "audio/ogg" ? "ogg" : "wav"}`,
        contentType: data.mimeType,
      });
      const result = await attachment.upload();
      if (result.upload_status !== "done") {
        throw new Error("recording_export_failed");
      }
      segment.dispatch({ type: "ready", reference: attachment.reference });
    } catch {
      segment.dispatch({ type: "omitted", reason: "recording_export_failed" });
    }
  }
}
