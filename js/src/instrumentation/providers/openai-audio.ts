import { audioAttachment } from "../../audio-attachments";
import { registry } from "../registry";
import {
  isAudioCaptureEnabled,
  processInputAttachments,
} from "../../wrappers/attachment-utils";

function audioConfig() {
  const config = registry.integrationConfig("openai");
  return typeof config === "object" ? config.audio : undefined;
}

export function openAIAudioCaptureEnabled(
  direction: "user" | "agent",
): boolean {
  return audioConfig() !== false && isAudioCaptureEnabled(direction);
}

export function openAIAudioAttachment(
  blob: Blob,
  filename: string,
  rawOutput = false,
) {
  const config = audioConfig();
  // OpenAI raw speech/chat PCM output is 24 kHz mono s16le. WAV uploads carry
  // their own format; compressed inputs/outputs retain their original encoding.
  return audioAttachment(
    blob,
    filename,
    config === false ? undefined : config,
    rawOutput ? { sampleRate: 24000, channels: 1 } : undefined,
  );
}

export function processOpenAIInputAttachments(
  input: unknown,
  capture: boolean,
  audioFormat?: string,
): unknown {
  return processInputAttachments(input, capture, audioFormat, {
    enabled: openAIAudioCaptureEnabled,
    attachment: (blob, filename) =>
      openAIAudioAttachment(
        blob,
        filename,
        audioFormat === "pcm16" || audioFormat === "pcm",
      ),
  });
}
