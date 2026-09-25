/** Experimental explicit registration for custom Twilio/OpenAI bridges. */
import { type Span } from "../../logger";
import { createVoiceRecorder } from "./recorder";
type Socket = {
  on(event: string, listener: (data: any) => void): unknown;
  send(data: any, ...args: any[]): unknown;
};
/** Register before application listeners; input must be forwarded unchanged and output paced. */
export function instrumentTwilioRealtime({
  twilio,
  realtime,
  ...options
}: {
  twilio: Socket;
  realtime: Socket;
  span: Span;
  retainAudio?: boolean;
  now?: () => number;
  segmentMs?: number;
  maxAudioBytes?: number;
}) {
  const recorder = createVoiceRecorder(options);
  // These raw sockets have no SDK methods to transform. The caller supplies ownership.
  function tap(
    socket: Socket,
    sent: (e: any) => void,
    received: (e: any) => void,
  ) {
    const original = socket.send;
    socket.send = function (data, ...args) {
      const result = original.call(this, data, ...args);
      try {
        sent(data);
      } catch {
        /* Never break app I/O. */
      }
      return result;
    };
    socket.on("message", (data) => {
      try {
        received(data);
      } catch {
        /* Never break app I/O. */
      }
    });
  }
  tap(twilio, recorder.outgoing, recorder.incoming);
  tap(realtime, recorder.modelSend, recorder.modelReceive);
  return { finish: recorder.finish };
}
