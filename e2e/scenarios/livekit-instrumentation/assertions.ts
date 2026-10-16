import { expect } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { findAllSpans } from "../../helpers/trace-selectors";

type Selection = {
  recording_span_id: string;
  recording_id: string;
  channel_index: number;
  start_offset_ms: number;
  end_offset_ms: number;
};
type Recording = {
  id: string;
  state: string;
  duration_ms: number;
  sample_rate_hz: number;
  channel_count: number;
  timeline: { origin_unix_ms: number; recording_start_offset_ms: number };
  attachment?: { span_id: string; ref: string };
};

// Compare coverage, allowing one 24 kHz PCM sample of boundary rounding.
// Adjacent selections may be compacted differently at the turn and speaking levels.
function coverage(selections: Selection[]) {
  const groups = new Map<string, [number, number][]>();
  for (const s of selections) {
    const key = JSON.stringify([
      s.recording_span_id,
      s.recording_id,
      s.channel_index,
    ]);
    const ranges = groups.get(key) ?? [];
    ranges.push([s.start_offset_ms, s.end_offset_ms]);
    groups.set(key, ranges);
  }
  return new Map(
    [...groups].map(([key, ranges]) => {
      const intervals: [number, number][] = [];
      for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
        const previous = intervals.at(-1);
        if (previous && start <= previous[1] + 1000 / 24000)
          previous[1] = Math.max(previous[1], end);
        else intervals.push([start, end]);
      }
      return [key, intervals];
    }),
  );
}

export function assertAudioTrace(
  raw: CapturedLogEvent[],
  {
    unassociatedSpeaking = [],
  }: { unassociatedSpeaking?: readonly string[] } = {},
) {
  const events = [...new Set(raw.map((e) => e.span.name))].flatMap((name) =>
    findAllSpans(raw, name!),
  );
  const recordings = new Map<string, Recording>();
  const key = (spanId: string, id: string) => JSON.stringify([spanId, id]);
  for (const event of events) {
    for (const r of (event.metadata?.["audio.recordings"] ??
      []) as Recording[]) {
      expect(recordings.has(key(event.span.id!, r.id))).toBe(false);
      recordings.set(key(event.span.id!, r.id), r);
      if (r.state !== "ready") continue;
      expect(Number.isFinite(r.duration_ms)).toBe(true);
      expect(r.duration_ms).toBeGreaterThan(0);
      expect(r.sample_rate_hz).toBeGreaterThan(0);
      expect(r.channel_count).toBeGreaterThan(0);
      expect(Number.isFinite(r.timeline.origin_unix_ms)).toBe(true);
      expect(r.timeline.recording_start_offset_ms).toBeGreaterThanOrEqual(0);
      expect(r.attachment).toBeDefined();
      const owner = events.find((e) => e.span.id === r.attachment!.span_id);
      expect(owner).toBeDefined();
      // Attachment references are JSON pointers into the owning row.
      const attachment = r
        .attachment!.ref.split("/")
        .slice(1)
        .reduce<unknown>(
          (value, part) =>
            (value as Record<string, unknown>)?.[
              part.replace(/~1/g, "/").replace(/~0/g, "~")
            ],
          owner!.row,
        );
      expect(attachment).toMatchObject({ type: "braintrust_attachment" });
    }
  }
  for (const event of events) {
    for (const s of (event.metadata?.["audio.selections"] ??
      []) as Selection[]) {
      const r = recordings.get(key(s.recording_span_id, s.recording_id));
      expect(r, `${event.span.name}: unknown recording`).toBeDefined();
      expect(r!.state).toBe("ready");
      expect(Number.isInteger(s.channel_index)).toBe(true);
      expect(s.channel_index).toBeGreaterThanOrEqual(0);
      expect(s.channel_index).toBeLessThan(r!.channel_count);
      if (["user_turn", "livekit.user_speaking"].includes(event.span.name!))
        expect(s.channel_index).toBe(0);
      if (
        ["assistant_turn", "livekit.agent_speaking"].includes(event.span.name!)
      )
        expect(s.channel_index).toBe(1);
      expect(
        Number.isFinite(s.start_offset_ms) && Number.isFinite(s.end_offset_ms),
      ).toBe(true);
      expect(s.start_offset_ms).toBeGreaterThanOrEqual(0);
      expect(s.end_offset_ms).toBeGreaterThan(s.start_offset_ms);
      expect(s.end_offset_ms).toBeLessThanOrEqual(
        r!.duration_ms + 1000 / r!.sample_rate_hz,
      );
    }
  }
  const unassociated = new Set(unassociatedSpeaking);
  for (const speech of events.filter((e) =>
    ["livekit.user_speaking", "livekit.agent_speaking"].includes(e.span.name!),
  )) {
    const turnId = speech.metadata?.["turn.id"];
    if (turnId === undefined && unassociated.delete(speech.span.id!)) {
      // Explicitly expected unassociated speech must remain session-owned.
      const parent = events.find((e) => e.span.id === speech.span.parentIds[0]);
      expect(parent?.span.name).toBe("livekit.agent_session");
      continue;
    }
    const turn = events.find((e) => e.span.id === turnId);
    expect(
      turn,
      `${speech.span.name}: missing or dangling turn.id`,
    ).toBeDefined();
    expect(turn!.span.name).toBe(
      speech.span.name === "livekit.user_speaking"
        ? "user_turn"
        : "assistant_turn",
    );
    expect(speech.row.span_parents).toEqual([turnId]);
  }
  expect(
    [...unassociated],
    "expected unassociated speaking spans were not found",
  ).toEqual([]);
  for (const turn of events.filter((e) =>
    ["user_turn", "assistant_turn"].includes(e.span.name!),
  )) {
    const children = events.filter(
      (e) =>
        ["livekit.user_speaking", "livekit.agent_speaking"].includes(
          e.span.name!,
        ) && e.metadata?.["turn.id"] === turn.span.id,
    );
    if (!children.length) continue;
    for (const child of children) {
      expect(child.row.span_parents).toEqual([turn.span.id]);
      expect(Number(turn.metrics?.start)).toBeLessThanOrEqual(
        Number(child.metrics?.start) + 0.005,
      );
      expect(Number(turn.metrics?.end) + 0.005).toBeGreaterThanOrEqual(
        Number(child.metrics?.end),
      );
    }
    const actual = coverage(
      (turn.metadata?.["audio.selections"] ?? []) as Selection[],
    );
    const expected = coverage(
      children.flatMap(
        (e) => (e.metadata?.["audio.selections"] ?? []) as Selection[],
      ),
    );
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, ranges] of expected) {
      expect(actual.get(key)).toHaveLength(ranges.length);
      ranges.forEach(([start, end], i) => {
        expect(actual.get(key)![i][0]).toBeCloseTo(start, 1);
        expect(actual.get(key)![i][1]).toBeCloseTo(end, 1);
      });
    }
  }
}
