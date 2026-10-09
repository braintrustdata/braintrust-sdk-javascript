import type { RecordingOptions } from "./audio";

export interface LiveKitOptions {
  captureContent?: boolean;
  captureAudio?: boolean;
  captureUserAudio?: boolean;
  captureAgentAudio?: boolean;
  audioFormat?: "ogg" | "wav";
  recording?: RecordingOptions;
  /** Group reconstructed caller speech across pauses; native turns are unchanged. */
  turnGrouping?: {
    /** Maximum observed pause in milliseconds. Default: 1500. */
    maxPauseMs?: number;
  };
}
