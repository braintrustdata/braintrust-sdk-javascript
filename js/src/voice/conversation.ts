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
import { audioFilename, mixToStereo, pcmToWav } from "./wav";

/** One party's contiguous stretch of speech. */
export class VoiceTurn {
  private _attachment: Attachment | null | undefined;

  constructor(
    readonly speaker: Speaker,
    private readonly _text: string,
    private _audio: AudioFrame | null = null,
    /** Milliseconds from the start of the call. */
    readonly atMs: number = 0,
  ) {}

  /** How long this turn took to say. Zero in text mode. */
  get durationMs(): number {
    if (!this._audio) return 0;
    return Math.round(
      (this._audio.data.length /
        this._audio.numChannels /
        this._audio.sampleRate) *
        1000,
    );
  }

  /**
   * @internal Cut this turn short, because the other party started talking.
   *
   * What the listener heard is what was played, so the recorded turn is the
   * truncated one. Keeping the full clip would make the transcript describe a
   * call that did not happen.
   */
  _truncate(playedMs: number): void {
    if (!this._audio) return;
    const perMs = (this._audio.sampleRate * this._audio.numChannels) / 1000;
    const keep = Math.max(
      0,
      Math.min(this._audio.data.length, Math.round(playedMs * perMs)),
    );
    this._audio = { ...this._audio, data: this._audio.data.slice(0, keep) };
    this._attachment = undefined;
  }

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
      at_ms: this.atMs,
      duration_ms: this.durationMs,
      ...(audio ? { audio } : {}),
    };
  }
}

/** The full exchange between the agent and the actor. */
export class Conversation {
  private _callAudio: Attachment | null | undefined;

  constructor(
    private readonly _turns: VoiceTurn[],
    readonly endReason: EndReason,
    private readonly _interruptions: Interruption[] = [],
  ) {}

  /** How long the call ran, in milliseconds. */
  get durationMs(): number {
    if (this._turns.length === 0) return 0;
    return Math.max(...this._turns.map((t) => t.atMs + t.durationMs));
  }

  /**
   * The whole call as one stereo file: caller left, agent right, on a real
   * timeline, so people talking over each other is audible rather than
   * inferred from timestamps.
   */
  audio(): Attachment | null {
    if (this._callAudio !== undefined) return this._callAudio;
    const mixed = mixToStereo(
      this._turns
        .map((t) => ({
          channel: (t.speaker === "actor" ? "left" : "right") as
            | "left"
            | "right",
          atMs: t.atMs,
          frame: t.frame(),
        }))
        .filter(
          (
            p,
          ): p is {
            channel: "left" | "right";
            atMs: number;
            frame: AudioFrame;
          } => p.frame !== null,
        ),
    );
    this._callAudio = mixed
      ? new Attachment({
          data: new Blob([
            pcmToWav(mixed.data, {
              sampleRate: mixed.sampleRate,
              numChannels: mixed.numChannels,
            }),
          ]),
          filename: audioFilename("call", {
            sampleRate: mixed.sampleRate,
            numChannels: mixed.numChannels,
          }),
          contentType: "audio/wav",
        })
      : null;
    return this._callAudio;
  }

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
    const callAudio = this.audio();
    return {
      end_reason: this.endReason,
      duration_ms: this.durationMs,
      interruptions: this._interruptions,
      // Both sides on one timeline, first, because it is the thing a person
      // actually wants to play.
      ...(callAudio ? { call_audio: callAudio } : {}),
      turns: this._turns.map((t) => t.toJSON()),
    };
  }
}
