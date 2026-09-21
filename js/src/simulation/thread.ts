/**
 * Building a thread, and reading one.
 *
 * A simulation observes every turn, so it builds the thread directly rather
 * than reconstructing it from a trace. The shape is the one `getThread()`
 * already returns, so a scorer cannot tell which produced it.
 */

import { Attachment } from "../logger";
import {
  AudioFrame,
  ContentPart,
  Interruption,
  Message,
  Role,
  Summary,
  Thread,
} from "./types";
import { audioFilename, mixToStereo, pcmToWav } from "./wav";

/** A turn while it is still being spoken, before it becomes a message. */
export class Turn {
  private _attachment: Attachment | null | undefined;

  constructor(
    readonly role: Role,
    readonly text: string,
    private _audio: AudioFrame | null,
    readonly atMs: number,
  ) {}

  get durationMs(): number {
    if (!this._audio) return 0;
    return Math.round(
      (this._audio.data.length /
        this._audio.numChannels /
        this._audio.sampleRate) *
        1000,
    );
  }

  frame(): AudioFrame | null {
    return this._audio;
  }

  /**
   * @internal Cut this turn short, because the other party started talking.
   *
   * What the listener heard is what was played, so the recorded turn is the
   * truncated one. Keeping the full clip would describe a conversation that
   * did not happen.
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
    this.truncatedAtMs = playedMs;
  }

  truncatedAtMs?: number;

  /** A handle, so the bytes are fetched only if a scorer wants them. */
  attachment(): Attachment | null {
    if (this._attachment !== undefined) return this._attachment;
    if (!this._audio) {
      this._attachment = null;
      return null;
    }
    const { data, sampleRate, numChannels } = this._audio;
    this._attachment = new Attachment({
      data: new Blob([pcmToWav(data, { sampleRate, numChannels })]),
      filename: audioFilename(`${this.role}_turn`, { sampleRate, numChannels }),
      contentType: "audio/wav",
    });
    return this._attachment;
  }

  /** The message this turn became. */
  toMessage(): Message {
    const content: ContentPart[] = [{ type: "text", text: this.text }];
    const audio = this.attachment();
    // Audio rides in the content part that already means audio, as a handle
    // rather than bytes, so the row stays small and the turn stays playable.
    if (audio) {
      content.push({
        type: "input_audio",
        input_audio: { data: audio, format: "wav" },
      });
    }
    return {
      role: this.role,
      content,
      metadata: {
        at_ms: this.atMs,
        duration_ms: this.durationMs,
        ...(this.truncatedAtMs !== undefined
          ? { truncated_at_ms: this.truncatedAtMs }
          : {}),
      },
    };
  }
}

/** The text of a message, joining its text parts. */
export function textOf(message: Message): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}

/** A handle to what this turn sounded like, or null in a text run. */
export function audioOf(message: Message): Attachment | null {
  for (const part of message.content) {
    if (part.type === "input_audio") return part.input_audio.data;
  }
  return null;
}

/**
 * The thread as a transcript string, for a scorer that calls a model itself.
 *
 * Labelled by participant rather than by persona: who the simulated user is
 * varies per case, so presuming they are a customer would be wrong as often
 * as it is right. Inside an autoevals template this is unnecessary, because a
 * message array already renders this way.
 */
export function formatThread(thread: Thread): string {
  return thread
    .map((m) => `${m.role === "assistant" ? "Agent" : "User"}: ${textOf(m)}`)
    .join("\n");
}

/** @internal What a finished simulation reports beside its thread. */
export function summarise(
  turns: Turn[],
  endReason: Summary["endReason"],
  interruptions: Interruption[],
  permissions: Summary["permissions"],
  agent?: string,
): Summary {
  const mixed = mixToStereo(
    turns
      .map((t) => ({
        channel: (t.role === "user" ? "left" : "right") as "left" | "right",
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
  return {
    ...(agent ? { agent } : {}),
    endReason,
    durationMs: turns.length
      ? Math.max(...turns.map((t) => t.atMs + t.durationMs))
      : 0,
    interruptions,
    audio: mixed
      ? new Attachment({
          data: new Blob([
            pcmToWav(mixed.data, {
              sampleRate: mixed.sampleRate,
              numChannels: mixed.numChannels,
            }),
          ]),
          filename: audioFilename("conversation", {
            sampleRate: mixed.sampleRate,
            numChannels: mixed.numChannels,
          }),
          contentType: "audio/wav",
        })
      : null,
    permissions,
  };
}
