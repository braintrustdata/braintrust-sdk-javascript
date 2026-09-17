/**
 * What a call produces.
 *
 * A `Conversation` is the task's output, so it is what `Eval` logs as the row
 * output and what every scorer receives as `args.output`. There is no
 * voice-specific scorer type: a voice eval is an ordinary eval whose output
 * happens to be a conversation.
 */

import { Attachment } from "../logger";
import { AudioFrame, EndReason, Interruption, Speaker } from "./types";
import { audioFilename, pcmToWav } from "./wav";

/** One party's contiguous stretch of speech. */
export class VoiceTurn {
  private _attachment: Attachment | null | undefined;

  constructor(
    readonly speaker: Speaker,
    private readonly _text: string,
    private readonly _audio: AudioFrame | null = null,
    readonly startedAt: number = Date.now(),
  ) {}

  text(): string {
    return this._text;
  }

  /** The raw frames, for a caller that wants to do its own DSP. */
  frame(): AudioFrame | null {
    return this._audio;
  }

  /**
   * A handle to what was heard, or null in text mode.
   *
   * A handle rather than bytes, so a scorer can pass it to an audio model or
   * resolve it locally, and audio that cannot leave a customer's perimeter
   * never has to.
   */
  audio(): Attachment | null {
    if (this._attachment !== undefined) return this._attachment;
    if (!this._audio) {
      this._attachment = null;
      return null;
    }
    const { data, sampleRate, numChannels } = this._audio;
    this._attachment = new Attachment({
      data: new Blob([pcmToWav(data, { sampleRate, numChannels })]),
      filename: audioFilename(`${this.speaker}_turn`, {
        sampleRate,
        numChannels,
      }),
      contentType: "audio/wav",
    });
    return this._attachment;
  }

  toJSON() {
    const audio = this.audio();
    return {
      speaker: this.speaker,
      text: this._text,
      ...(audio ? { audio } : {}),
    };
  }
}

/** The full exchange between the agent and the actor. */
export class Conversation {
  constructor(
    private readonly _turns: VoiceTurn[],
    readonly endReason: EndReason,
    private readonly _interruptions: Interruption[] = [],
  ) {}

  turns(): VoiceTurn[] {
    return [...this._turns];
  }

  /** The shape an LLM judge wants. */
  transcript(): Array<{ speaker: Speaker; text: string }> {
    return this._turns.map((t) => ({ speaker: t.speaker, text: t.text() }));
  }

  /** Overlap, so it can be scored rather than inferred from timestamps. */
  interruptions(): Interruption[] {
    return [...this._interruptions];
  }

  /** The transcript as text, ready to drop into a judge prompt. */
  formatTranscript(): string {
    return this._turns
      .map(
        (t) => `${t.speaker === "agent" ? "Agent" : "Customer"}: ${t.text()}`,
      )
      .join("\n");
  }

  /**
   * Serialised onto the span as the row's output.
   *
   * Turn attachments are left in place on purpose: `extractAttachments` walks
   * the logged event and swaps any it finds for a reference, so per-turn audio
   * becomes playable in the UI with no extra wiring.
   */
  toJSON() {
    return {
      end_reason: this.endReason,
      interruptions: this._interruptions,
      turns: this._turns.map((t) => t.toJSON()),
    };
  }
}
