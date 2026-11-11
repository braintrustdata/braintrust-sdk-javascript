import { AudioRecorder } from "./audio-recorder";
import type {
  AudioMiddlewareStack,
  AudioSegmentMeta,
} from "./audio-middleware";

/** The version of the audio trace schema this recorder implements. */
const AUDIO_SCHEMA_VERSION = "3.0.0";

type AudioMemberType = "user" | "agent" | "other" | "unknown";
/** A participant or speaker, as published in `audio.participants` / `audio.speakers`. */
export type AudioMember = {
  type: AudioMemberType;
  label?: string;
  attributes?: Record<string, unknown>;
};

/** `audio.*` metadata for the session span, merged into what is already published. */
export type AudioMetadata = Record<string, unknown>;

/** A recorded segment to store, with the entry to publish once it is stored. */
export interface AudioFile {
  /** Stable segment ID, also its attachment key: `input.audio[id]`. */
  readonly id: string;
  /** The file's bytes; absent when the segment is omitted. */
  readonly data?: Uint8Array;
  readonly mimeType?: string;
  /** The segment's `audio.segments` entry. */
  readonly metadata: AudioMetadata;
}

type AudioSegmentEntry = {
  state: "ready" | "omitted";
  start_offset_ms: number;
  duration_ms?: number;
  attachment?: { ref: string };
  mime_type?: string;
  encoding?: string;
  sample_rate_hz?: number;
  channels?: Record<string, { sources: string[] }>;
  attributes?: Record<string, unknown>;
  reason?: string;
};

type AudioSessionRecorderOptions = {
  /** The session timeline's epoch, in milliseconds since the Unix epoch. */
  origin: number;
  /** Audio sources by ID; recorded channels follow this order. */
  sources: Record<string, { label?: string }>;
  /** Records audio with these settings; omit to describe the session without audio. */
  audio?: {
    sampleRate: number;
    segmentBytes: number;
    maxBufferBytes?: number;
    maxDurationMs?: number;
    middleware?: AudioMiddlewareStack;
  };
  /**
   * Stores a segment, for example as an attachment at `input.audio[file.id]`
   * on the session span, then publishes `file.metadata` with it. A file
   * without data is omitted: publish its metadata only. If storing throws,
   * the segment is offered again as omitted and recording stops.
   */
  onFile?(file: AudioFile): Promise<void>;
};

/**
 * Assigns stable, session-local IDs to native identities: the same key always
 * yields the same ID, numbered in order of first observation.
 */
class Members {
  private ids = new Map<string, string>();

  constructor(
    private field: string,
    private prefix: string,
  ) {}

  observe(
    key: string,
    member: AudioMember,
  ): { id: string; added?: AudioMetadata } {
    const known = this.ids.get(key);
    if (known) return { id: known };
    const id = `${this.prefix}-${this.ids.size + 1}`;
    this.ids.set(key, id);
    return { id, added: { [this.field]: { [id]: member } } };
  }
}

/**
 * One session's audio description: sources, timeline, participants, speakers
 * and recorded segments, in the `audio.*` metadata shape. It answers calls and
 * hands back what to publish; it never logs, and knows nothing about spans or
 * the framework. Records audio through an internal AudioRecorder when configured.
 */
export class AudioSessionRecorder {
  private recorder?: AudioRecorder;
  private participants = new Members("audio.participants", "participant");
  private speakers = new Members("audio.speakers", "speaker");
  private finishing?: Promise<void>;

  constructor(private options: AudioSessionRecorderOptions) {
    const { audio } = options;
    if (!audio) return;
    this.recorder = new AudioRecorder({
      ...audio,
      sources: Object.keys(options.sources),
      onFlush: (data, meta) => this.store(data, meta),
      onError: (meta, reason) => this.omit(meta, reason),
    });
  }

  /** Whether audio is still being accepted. */
  get active(): boolean {
    return this.recorder?.active ?? false;
  }
  get closed(): boolean {
    return this.recorder?.closed ?? true;
  }
  /** Why recording stopped early, if it did. */
  get reason(): string | undefined {
    return this.recorder?.reason;
  }
  stop(reason: string): void {
    this.recorder?.stop(reason);
  }

  /** What the session publishes when it starts: its schema, sources and timeline. */
  session(): AudioMetadata {
    return {
      "audio.schema.version": AUDIO_SCHEMA_VERSION,
      "audio.sources": this.options.sources,
      "audio.timeline": { origin_unix_ms: this.options.origin },
    };
  }

  /**
   * The participant ID for a member of the conversation, keyed by its native
   * ID. `added` is the entry to publish, returned the first time only.
   */
  participant(
    nativeId: string,
    member: AudioMember,
  ): { id: string; added?: AudioMetadata } {
    return this.participants.observe(nativeId, member);
  }

  /**
   * The speaker ID for a voice heard on a source, keyed by an opaque native
   * identity: the same key on the same source is the same voice. `added` is
   * the entry to publish, returned the first time only.
   */
  speaker(
    source: string,
    nativeId: string,
    member: AudioMember,
  ): { id: string; added?: AudioMetadata } {
    return this.speakers.observe(JSON.stringify([source, nativeId]), member);
  }

  /** Adds PCM from a source at a session offset. False once recording stops. */
  record(
    source: string,
    samples: Int16Array,
    format: { sampleRate: number; channelCount: number; offsetMs: number },
  ): boolean {
    return this.recorder?.record(source, samples, format) ?? false;
  }
  /** Reserves memory for audio held outside the recorder, such as staged output. */
  reserve(bytes: number): boolean {
    return this.recorder?.reserve(bytes) ?? false;
  }
  release(bytes: number): void {
    this.recorder?.release(bytes);
  }
  /** Allows segments to be cut up to this session offset. */
  advance(throughMs: number): void {
    this.recorder?.advance(throughMs);
  }

  /** Records the remaining audio and waits until every segment is handed off. */
  finish(): Promise<void> {
    return (this.finishing ??= (async () => {
      await this.recorder?.finish();
    })());
  }

  private async store(data: Uint8Array, meta: AudioSegmentMeta) {
    const id = segmentId(meta);
    const entry: AudioSegmentEntry = {
      ...placement(meta),
      state: "ready",
      attachment: { ref: `/input/audio/${id}` },
      ...formatFields(meta),
    };
    try {
      await this.options.onFile?.({
        id,
        data,
        mimeType: meta.mimeType,
        metadata: segments(id, entry),
      });
    } catch {
      this.stop("recording_export_failed");
      await this.omit(meta, "recording_export_failed");
    }
  }

  private async omit(meta: AudioSegmentMeta, reason: string): Promise<void> {
    const id = segmentId(meta);
    const entry: AudioSegmentEntry = {
      ...placement(meta),
      state: "omitted",
      reason,
    };
    try {
      await this.options.onFile?.({ id, metadata: segments(id, entry) });
    } catch {
      // Nothing else can be done about a segment that cannot even be described.
    }
  }
}

function segmentId(meta: AudioSegmentMeta): string {
  return `part-${meta.index}`;
}

function segments(id: string, entry: AudioSegmentEntry): AudioMetadata {
  return { "audio.segments": { [id]: entry } };
}

/** The segment's place on the timeline, in whole milliseconds without drift. */
function placement(meta: AudioSegmentMeta) {
  const start = Math.round(meta.startOffsetMs);
  const end = Math.round(meta.startOffsetMs + meta.durationMs);
  return { start_offset_ms: start, duration_ms: end - start };
}

/** What the file is, as described by the pipeline that produced it. */
function formatFields(meta: AudioSegmentMeta): Partial<AudioSegmentEntry> {
  return {
    mime_type: meta.mimeType,
    encoding: meta.encoding,
    sample_rate_hz: meta.sampleRate,
    channels: Object.fromEntries(
      meta.channels.map((c, index) => [
        String(index),
        { sources: [...c.sources] },
      ]),
    ),
    ...(meta.attributes && { attributes: { ...meta.attributes } }),
  };
}
