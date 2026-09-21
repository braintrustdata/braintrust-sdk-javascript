/**
 * The agent's handle on an in-process conversation.
 *
 * Its own module so a `Connection` can hand one over without importing the
 * run, which would be a cycle. Nothing on a real interface touches this,
 * because there the wire is real and the connection owns it.
 */

import { InProcessLeg } from "./legs";
import { AudioFrame } from "./types";

export class Call {
  constructor(private readonly leg: InProcessLeg) {}

  /** Wait for the user to say something. Null when it is over. */
  async listen(): Promise<string | null> {
    const heard = await this.leg.toAgent.take();
    return heard ? heard.text : null;
  }

  get audio(): ReadableStream<AudioFrame> {
    const leg = this.leg;
    return new ReadableStream<AudioFrame>({
      async pull(controller) {
        const heard = await leg.toAgent.take();
        if (!heard) return controller.close();
        if (heard.audio) controller.enqueue(heard.audio);
      },
    });
  }

  async sendAudio(frame: AudioFrame): Promise<void> {
    this.leg.toRoom.put({ text: "", audio: frame });
  }

  /** The text tier, for a run without speech. */
  async say(text: string): Promise<void> {
    this.leg.toRoom.put({ text, audio: null });
  }

  /** Barge-in. `playedMs` is how much was actually heard, when known. */
  cancelOutput(_playedMs?: number): void {
    // Nothing is buffered in-process, so there is nothing to discard.
  }

  hangUp(): void {
    this.leg.toRoom.put(null);
  }
}
