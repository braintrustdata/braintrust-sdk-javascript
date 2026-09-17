import { placeholderTone } from "./wav";
import { VoiceRenderer } from "./types";

/**
 * PLACEHOLDER AUDIO. A fixed tone per turn, so the attachment path is
 * exercised end to end. It is not speech and does not match what was said.
 */
export const placeholderAudio: VoiceRenderer = async (_text, speaker) =>
  placeholderTone({ frequency: speaker === "agent" ? 440 : 660 });
