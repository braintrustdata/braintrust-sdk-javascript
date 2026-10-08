import type { RecordingOptions } from "./audio";

export interface LiveKitOptions {
  captureContent?: boolean;
  captureAudio?: boolean;
  captureUserAudio?: boolean;
  captureAgentAudio?: boolean;
  audioFormat?: "ogg" | "wav";
  recording?: RecordingOptions;
}
