import { expect, it } from "vitest";
import { Attachment } from "../../logger";
import {
  copyLiveKitAudio,
  liveKitAudioParts,
  liveKitMessages,
  liveKitToolValue,
} from "./livekit-agents-data";

it("encodes PCM as a valid WAV and snapshots reused native buffers", async () => {
  const source = {
    data: new Int16Array([10, -10]),
    sampleRate: 16000,
    channels: 1,
    samplesPerChannel: 2,
  };
  const copy = copyLiveKitAudio(source)!;
  source.data.fill(0);
  const parts = liveKitAudioParts([copy]) as Array<{
    file: { file_data: Attachment };
  }>;
  const blob = await parts[0].file.file_data.data();
  const data = await blob.arrayBuffer();
  const view = new DataView(data);
  expect(new TextDecoder().decode(data.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(40, true)).toBe(4);
  expect(view.getInt16(44, true)).toBe(10);
  expect(view.getInt16(46, true)).toBe(-10);
  expect(
    liveKitAudioParts([copy, { ...copy, sampleRate: 24000 }]),
  ).toHaveLength(2);
});

it("keeps message and tool order, remote references, and opt-in inline media", () => {
  const image = {
    type: "image_content",
    image: "data:image/png;base64,aGVsbG8=",
  };
  const remote = {
    type: "image_content",
    image: "https://example.com/image.png",
  };
  const native = {
    type: "image_content",
    image: { nativeFrame: true },
    _cache: {
      serialized_image: { mimeType: "image/jpeg", base64Data: "aGVsbG8=" },
    },
  };
  const context = {
    items: [
      {
        type: "message",
        role: "user",
        content: ["hello", image, remote, native],
      },
      { type: "function_call", callId: "call-1", name: "weather", args: "{}" },
      { type: "function_call_output", callId: "call-1", output: "sunny" },
    ],
  };
  const disabled = liveKitMessages(context, false);
  expect(disabled[0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "image_url", image_url: { url: remote.image } },
    ],
  });
  expect(disabled[1]).toMatchObject({
    role: "assistant",
    tool_calls: [
      { id: "call-1", function: { name: "weather", arguments: "{}" } },
    ],
  });
  expect(disabled[2]).toMatchObject({
    role: "tool",
    tool_call_id: "call-1",
    content: "sunny",
  });
  const cache = new WeakMap<object, unknown[]>();
  const enabled = liveKitMessages(context, true, cache) as Array<{
    content: Array<{ image_url?: { url: Attachment } }>;
  }>;
  expect(enabled[0].content[1].image_url?.url.reference).toMatchObject({
    content_type: "image/png",
    filename: "image.png",
  });
  expect(enabled[0].content[3].image_url?.url.reference).toMatchObject({
    content_type: "image/jpeg",
  });
  const repeated = liveKitMessages(context, true, cache) as typeof enabled;
  expect(repeated[0].content[1]).toBe(enabled[0].content[1]);
});

it("does not inspect binary audio or native image caches without opt-in", () => {
  const input = {
    items: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "audio_content",
            transcript: "hello",
            get frame() {
              throw new Error("read audio");
            },
          },
          {
            type: "image_content",
            image: {},
            get _cache() {
              throw new Error("read image cache");
            },
          },
        ],
      },
    ],
  };
  expect(liveKitMessages(input, false)).toEqual([
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
  expect(
    liveKitToolValue(
      { agent: { apiKey: "secret" }, returns: "handoff" },
      false,
    ),
  ).toBe("handoff");
});
