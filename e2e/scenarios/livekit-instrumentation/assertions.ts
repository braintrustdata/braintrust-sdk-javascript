import { expect } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { findAllSpans } from "../../helpers/trace-selectors";

export type AudioSegment = {
  state: "pending" | "ready" | "omitted";
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
type AudioMember = { type: string; label?: string };
export type AudioSession = {
  sources: Record<string, { label?: string }>;
  participants?: Record<string, AudioMember>;
  speakers?: Record<string, AudioMember>;
  segments?: Record<string, AudioSegment>;
  timeline: { origin_unix_ms: number };
};
type Selection = { start_offset_ms: number; end_offset_ms: number };

/** The session's audio metadata, with segments in recording order. */
export function audioSession(event: CapturedLogEvent | undefined) {
  const metadata = event?.metadata;
  const session: AudioSession | undefined = metadata?.["audio.sources"]
    ? {
        sources: metadata["audio.sources"],
        participants: metadata["audio.participants"],
        speakers: metadata["audio.speakers"],
        segments: metadata["audio.segments"],
        timeline: metadata["audio.timeline"],
      }
    : undefined;
  const segments = Object.entries(session?.segments ?? {})
    .map(([id, segment]) => ({ id, ...segment }))
    .sort((a, b) => a.start_offset_ms - b.start_offset_ms);
  return { session, segments };
}

/** A speech span's selections on its session timeline, in order. */
export function selectionsOf(span: CapturedLogEvent | undefined) {
  return (
    Object.values(span?.metadata?.["audio.selections"] ?? {}) as Selection[]
  ).sort((a, b) => a.start_offset_ms - b.start_offset_ms);
}

const SESSION_KEYS = [
  "audio.schema.version",
  "audio.sources",
  "audio.participants",
  "audio.speakers",
  "audio.segments",
  "audio.timeline",
];

/** The schema's span kind: tools are named for the tool, so use their type. */
const kind = (event: CapturedLogEvent) =>
  event.span.type === "tool" ? "tool" : event.span.name!;
const SPEECH = ["user_speech", "agent_speech"];
const LINKS: Record<string, { source: string[]; target: string[] }> = {
  uses_context: {
    source: ["llm_response"],
    target: [...SPEECH, "stt", "transcript_received"],
  },
  requested_by: { source: ["tool"], target: ["llm_response"] },
  consumes_tool_result: { source: ["llm_response"], target: ["tool"] },
  generated_by: {
    source: ["agent_speech", "tts"],
    target: ["llm_response", "tts"],
  },
  transcribes: { source: ["stt", "transcript_received"], target: SPEECH },
};

/** Checks the session audio, speech selections, and turn ownership. */
export function assertAudioTrace(raw: CapturedLogEvent[]) {
  const events = [...new Set(raw.map((e) => e.span.name))].flatMap((name) =>
    findAllSpans(raw, name!),
  );
  for (const event of events) {
    expect(event.metadata).not.toHaveProperty("audio.recordings");
    expect(event.metadata).not.toHaveProperty("audio.session");
    expect(event.metadata).not.toHaveProperty("audio.selection");
    expect(event.metadata).not.toHaveProperty("audio.source");
    if (event.span.name !== "session")
      for (const key of SESSION_KEYS)
        expect(event.metadata, event.span.name).not.toHaveProperty(key);
    // Only agent playout shares the recording's clock.
    if (event.span.name !== "agent_speech")
      expect(event.metadata, event.span.name).not.toHaveProperty(
        "audio.selections",
      );
  }
  for (const event of events.filter((e) => e.span.name === "session")) {
    const { session, segments } = audioSession(event);
    if (!session) continue;
    expect(event.metadata?.["audio.schema.version"]).toBe("3.0.0");
    expect(Number.isInteger(session.timeline.origin_unix_ms)).toBe(true);
    for (const member of [
      ...Object.values(session.participants ?? {}),
      ...Object.values(session.speakers ?? {}),
    ])
      expect(["user", "agent", "other", "unknown"]).toContain(member.type);
    let previousEnd = -Infinity;
    for (const segment of segments) {
      expect(Number.isInteger(segment.start_offset_ms)).toBe(true);
      expect(segment.start_offset_ms).toBeGreaterThanOrEqual(previousEnd);
      if (segment.duration_ms !== undefined) {
        expect(Number.isInteger(segment.duration_ms)).toBe(true);
        previousEnd = segment.start_offset_ms + segment.duration_ms;
      }
      if (segment.state === "omitted") expect(segment.reason).toBeTruthy();
      if (segment.state !== "ready") continue;
      expect(segment.duration_ms).toBeGreaterThan(0);
      expect(segment.mime_type).toBeTruthy();
      expect(segment.encoding).toBeTruthy();
      // Every output channel, keyed "0", "1", ..., naming known sources.
      const channels = Object.keys(segment.channels!);
      expect(channels).toEqual(channels.map((_, i) => String(i)));
      for (const channel of Object.values(segment.channels!))
        for (const source of channel.sources)
          expect(session.sources).toHaveProperty(source);
      if (segment.mime_type === "audio/pcm") {
        expect(segment.sample_rate_hz).toBeGreaterThan(0);
        expect(segment.attributes).toMatchObject({
          "pcm.sample_format": "s16le",
          "pcm.channel_layout": "interleaved",
        });
      }
      // Attachment references are JSON pointers into the session row.
      const attachment = segment
        .attachment!.ref.split("/")
        .slice(1)
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          event.row,
        );
      expect(attachment).toMatchObject({ type: "braintrust_attachment" });
    }
  }
  const { session } = audioSession(
    events.find((e) => e.span.name === "session"),
  );
  for (const span of events.filter((e) =>
    ["user_speech", "agent_speech", "stt"].includes(e.span.name!),
  )) {
    const source = span.metadata?.["audio.source_id"] as string | undefined;
    expect(source, `${span.span.name}: audio.source_id`).toBe(
      span.span.name === "agent_speech" ? "agent-output" : "session-input",
    );
    expect(session?.sources).toHaveProperty(source!);
    for (const participant of (span.metadata?.["audio.participant_ids"] ??
      []) as string[])
      expect(session?.participants).toHaveProperty(participant);
    for (const speaker of (span.metadata?.["audio.speaker_ids"] ??
      []) as string[])
      expect(session?.speakers).toHaveProperty(speaker);
    for (const selection of selectionsOf(span)) {
      expect(Number.isInteger(selection.start_offset_ms)).toBe(true);
      expect(Number.isInteger(selection.end_offset_ms)).toBe(true);
      expect(selection.start_offset_ms).toBeGreaterThanOrEqual(0);
      expect(selection.end_offset_ms).toBeGreaterThan(
        selection.start_offset_ms,
      );
    }
  }
  for (const turn of events.filter((e) =>
    ["user_turn", "agent_turn"].includes(e.span.name!),
  ))
    expect(turn.metadata?.["turn.id"]).toBe(turn.span.id);
  for (const speech of events.filter((e) =>
    ["user_speech", "agent_speech"].includes(e.span.name!),
  )) {
    const turnId = speech.metadata?.["turn.id"];
    if (turnId === undefined) {
      const parent = events.find((e) => e.span.id === speech.span.parentIds[0]);
      expect(parent?.span.name).toBe("session");
      continue;
    }
    const turn = events.find((e) => e.span.id === turnId);
    expect(turn?.span.name, `${speech.span.name}: dangling turn.id`).toBe(
      speech.span.name === "user_speech" ? "user_turn" : "agent_turn",
    );
    expect(speech.row.span_parents).toEqual([turnId]);
  }
  for (const source of events)
    for (const link of (source.metadata?.links ?? []) as {
      context: { traceId: string; spanId: string };
      attributes: Record<string, string>;
    }[]) {
      const target = events.find((e) => e.span.id === link.context.spanId);
      expect(target, "link target must be an exported span").toBeDefined();
      expect(target!.row.root_span_id).toBe(link.context.traceId);
      const type = link.attributes["braintrust.relationship.type"];
      const allowed = LINKS[type];
      expect(allowed, `unknown relationship ${type}`).toBeDefined();
      // Sources and targets as the schema's relationship table allows.
      expect(allowed.source, type).toContain(kind(source));
      expect(allowed.target, type).toContain(kind(target!));
    }
  return events;
}
