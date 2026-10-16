import type { AudioExtension } from "../audio";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { LiveKitOptions } from "../options";

export function resolveAudioOptions(
  options: LiveKitOptions,
  loadExtension: () => AudioExtension = () => {
    const app = createRequire(join(process.cwd(), "package.json"));
    return app("@braintrust/audio");
  },
) {
  const flag = (name: string) => {
    const value = process.env[name];
    return (
      value !== undefined && ["1", "true"].includes(value.trim().toLowerCase())
    );
  };
  const user =
    options.captureUserAudio ??
    options.captureAudio ??
    flag("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS");
  const agent =
    options.captureAgentAudio ??
    options.captureAudio ??
    flag("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS");
  // No extension resolution, loading, or capture work unless recording is enabled.
  if (!user && !agent) return { user, agent };
  if (
    options.audioFormat !== undefined &&
    options.audioFormat !== "wav" &&
    options.audioFormat !== "ogg"
  )
    throw new Error("Invalid LiveKit audio format");
  try {
    return { user, agent, extension: loadExtension() };
  } catch {
    // eslint-disable-next-line no-restricted-properties -- actionable configuration diagnostic, once per processor.
    console.warn(
      "LiveKit audio recording requires @braintrust/audio. Install it to enable recordings. Non-audio tracing remains enabled.",
    );
    return { user: false, agent: false };
  }
}
