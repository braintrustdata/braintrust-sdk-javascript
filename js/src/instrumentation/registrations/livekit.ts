import { registerLiveKitInstrumentation } from "../providers/livekit-plugin";
import { registry } from "../registry";

/** Enable this provider once across compatible SDK copies. */
export function registerInstrumentation(): void {
  registry.register("livekit", (integrations, config) => {
    registerLiveKitInstrumentation(
      config.streamingAttachmentBufferBytes,
      typeof integrations.livekit === "object"
        ? integrations.livekit.audio
        : undefined,
    );
  });
}
