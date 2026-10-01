import { isObject } from "../../../util";
import { Attachment } from "../../logger";
import type {
  LiveKitAudioFrame,
  LiveKitChatContext,
  LiveKitToolContext,
} from "../../vendor-sdk-types/livekit-agents";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
  processInputAttachments,
} from "../../wrappers/attachment-utils";
import { zodToJsonSchema, type ZodSchema } from "../../zod/utils";

/** Copy frames as they are consumed: rtc-node may reuse the underlying buffer. */
export function copyLiveKitAudio(
  value: unknown,
): LiveKitAudioFrame | undefined {
  if (
    !isObject(value) ||
    !(value.data instanceof Int16Array) ||
    typeof value.sampleRate !== "number" ||
    typeof value.channels !== "number" ||
    value.channels <= 0
  )
    return undefined;
  return {
    data: new Int16Array(value.data),
    sampleRate: value.sampleRate,
    channels: value.channels,
    samplesPerChannel: value.data.length / value.channels,
  };
}

/** Consecutive frames of the same PCM format form one playable WAV artifact. */
export function liveKitAudioParts(frames: LiveKitAudioFrame[]): unknown[] {
  const groups: LiveKitAudioFrame[][] = [];
  for (const frame of frames) {
    const group = groups.at(-1);
    if (
      group &&
      group[0].sampleRate === frame.sampleRate &&
      group[0].channels === frame.channels
    )
      group.push(frame);
    else groups.push([frame]);
  }
  return groups.map((group, index) => {
    const data = encodeWav(group);
    const filename = `audio-${index + 1}.wav`;
    return {
      type: "file",
      file: {
        filename,
        byte_size: data.byteLength,
        file_data: new Attachment({
          data: new Blob([data], { type: "audio/wav" }),
          filename,
          contentType: "audio/wav",
        }),
      },
    };
  });
}

/** Encode 16-bit PCM frames sharing one format as a WAV file. */
function encodeWav(frames: LiveKitAudioFrame[]): ArrayBuffer {
  const { sampleRate, channels } = frames[0];
  const dataSize =
    frames.reduce((total, frame) => total + frame.data.length, 0) * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const frame of frames) {
    for (const sample of frame.data) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return buffer;
}

export function liveKitMessages(
  context: LiveKitChatContext,
  capture: boolean,
  attachments = new WeakMap<object, unknown[]>(),
): unknown[] {
  return context.items.flatMap((item): unknown[] => {
    if (item.type === "function_call")
      return [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.callId,
              type: "function",
              function: { name: item.name, arguments: item.args },
            },
          ],
        },
      ];
    if (item.type === "function_call_output")
      return [
        { role: "tool", tool_call_id: item.callId, content: item.output },
      ];
    if (item.type !== "message") return [];
    const content = (item.content ?? []).flatMap((part): unknown[] => {
      if (typeof part === "string") return [{ type: "text", text: part }];
      if (!isObject(part)) return [];
      const cached = capture ? attachments.get(part) : undefined;
      if (cached) return cached;
      if (part.type === "image_content") {
        let source = typeof part.image === "string" ? part.image : undefined;
        // Native VideoFrames are encoded by the provider. Reuse that result;
        // never probe remote URLs or serialize raw native frame objects.
        if (capture && !source && isObject(part._cache)) {
          const serialized = part._cache.serialized_image;
          if (
            isObject(serialized) &&
            typeof serialized.base64Data === "string" &&
            typeof serialized.mimeType === "string"
          ) {
            source = `data:${serialized.mimeType};base64,${serialized.base64Data}`;
          }
        }
        if (!source) return [];
        if (/^https?:/.test(source))
          return [{ type: "image_url", image_url: { url: source } }];
        if (!capture) return [];
        const blob = convertDataToBlob(
          source,
          source.match(/^data:([^;]+);/)?.[1] ??
            (typeof part.mimeType === "string" ? part.mimeType : "image/jpeg"),
        );
        if (!blob) return [];
        const parts = [
          {
            type: "image_url",
            image_url: {
              url: new Attachment({
                data: blob,
                filename: `image.${getExtensionFromMediaType(blob.type)}`,
                contentType: blob.type,
              }),
            },
          },
        ];
        attachments.set(part, parts);
        return parts;
      }
      if (part.type === "audio_content") {
        const result: unknown[] =
          typeof part.transcript === "string"
            ? [{ type: "text", text: part.transcript }]
            : [];
        if (capture && Array.isArray(part.frame)) {
          result.push(
            ...liveKitAudioParts(
              part.frame.flatMap((frame) => {
                const copy = copyLiveKitAudio(frame);
                return copy ? [copy] : [];
              }),
            ),
          );
        }
        if (capture) attachments.set(part, result);
        return result;
      }
      return [];
    });
    return [{ role: item.role, content }];
  });
}

export function liveKitToolDefinitions(context: LiveKitToolContext): unknown[] {
  return Object.entries(context.functionTools).map(([name, tool]) => {
    const schema = tool.parameters;
    return {
      type: "function",
      function: {
        name,
        description: tool.description,
        parameters:
          isObject(schema) && ("_def" in schema || "_zod" in schema)
            ? zodToJsonSchema(schema as unknown as ZodSchema)
            : schema,
      },
    };
  });
}

export function liveKitToolValue(value: unknown, capture: boolean): unknown {
  // A handoff contains the next Agent (and potentially provider credentials).
  // Only its model-visible return value belongs in tool output.
  if (isObject(value) && "agent" in value && "returns" in value)
    value = value.returns;
  return processInputAttachments(value, capture);
}
