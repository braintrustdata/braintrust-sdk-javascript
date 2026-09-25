import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import { startSpan } from "../../logger";
import { debugLogger } from "../../debug-logger";
import { createVoiceRecorder } from "../../experimental/voice/recorder";
import { isAutoCaptureAttachmentsEnabled } from "../../wrappers/attachment-utils";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import {
  twilioRealtimeChannels,
  realtimeSendChannels,
} from "./twilio-realtime-channels";

export class TwilioRealtimePlugin extends BasePlugin {
  private calls = new WeakMap<object, ReturnType<typeof createVoiceRecorder>>();
  protected onEnable(): void {
    this.unsubscribers.push(
      twilioRealtimeChannels.connect.intercept(
        (target, transport: any, args) => {
          if (isAutoInstrumentationSuppressed() || this.calls.has(transport))
            return Reflect.apply(target, transport, args);
          const span = startSpan({
            name: "voice_session",
            event: {
              metadata: {
                instrumentation: "openai-agents-twilio",
                "audio.retained": isAutoCaptureAttachmentsEnabled(),
                "audio.output_timing":
                  "estimated Twilio queue; not confirmed playback",
              },
            },
          });
          const recorder = createVoiceRecorder({
            span,
            retainAudio: isAutoCaptureAttachmentsEnabled(),
            outputClock: "twilio.queue_estimate",
            allowInputGaps: true,
          });
          this.calls.set(transport, recorder);
          let started = false,
            finished = false;
          const onEvent = (event: any) => {
            if (event.type === "twilio_message") {
              started ||= event.message.event === "start";
              recorder.incoming(event.message);
              // Media received while connecting is dropped by the stock adapter.
              if (transport.status !== "connected")
                recorder.resetPendingInput();
            } else recorder.modelReceive(event);
          };
          const onAudio = (event: any) => {
            // In adapter 0.18.0, audio is emitted after a successful Twilio send.
            // The missing-item fallback also emits audio, but sends nothing.
            if (started && transport.currentItemId != null)
              recorder.outgoing({
                event: "media",
                media: { payload: Buffer.from(event.data).toString("base64") },
              });
          };
          const finish = () => {
            if (finished) return;
            finished = true;
            recorder.finish();
            span.end();
            this.calls.delete(transport);
            transport.off("*", onEvent);
            transport.off("audio", onAudio);
            transport.off("connection_change", onConnection);
          };
          const onConnection = (status: string) => {
            if (status === "disconnected") finish();
          };
          transport.on("*", onEvent);
          transport.on("audio", onAudio);
          transport.on("connection_change", onConnection);
          try {
            return Promise.resolve(
              Reflect.apply(target, transport, args),
            ).catch((error) => {
              span.log({ error: String(error) });
              finish();
              throw error;
            });
          } catch (error) {
            finish();
            throw error;
          }
        },
      ),
    );
    this.unsubscribers.push(
      realtimeSendChannels.send.intercept((target, transport: any, args) => {
        const result = Reflect.apply(target, transport, args);
        this.calls.get(transport)?.modelSend(args[0]);
        return result;
      }),
    );
    this.unsubscribers.push(
      twilioRealtimeChannels.clear.intercept((target, transport: any, args) => {
        const result = Reflect.apply(target, transport, args);
        try {
          this.calls.get(transport)?.outgoing({ event: "clear" });
        } catch (error) {
          debugLogger.warn("Twilio recording failed", error);
        }
        return result;
      }),
    );
  }
  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}
