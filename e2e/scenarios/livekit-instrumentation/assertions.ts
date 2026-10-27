import { expect } from "vite-plus/test";
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
  attachment?: { span_id: string; ref: string };
};

/** Checks recording references, speech selections, and turn ownership. */
export function assertAudioTrace(raw: CapturedLogEvent[]) {
  const events = [...new Set(raw.map((e) => e.span.name))].flatMap((name) =>
    findAllSpans(raw, name!),
  );
  const recordings = new Map<string, Recording>();
  for (const event of events) {
    for (const r of (event.metadata?.["audio.recordings"] ??
      []) as Recording[]) {
      const key = `${event.span.id}/${r.id}`;
      expect(recordings.has(key)).toBe(false);
      recordings.set(key, r);
      if (r.state !== "ready") continue;
      expect(r.duration_ms).toBeGreaterThan(0);
      expect(r.attachment!.span_id).toBe(event.span.id);
      // Attachment references are JSON pointers into the owning row.
      const attachment = r
        .attachment!.ref.split("/")
        .slice(1)
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          event.row,
        );
      expect(attachment).toMatchObject({ type: "braintrust_attachment" });
    }
  }
  for (const event of events) {
    for (const s of (event.metadata?.["audio.selections"] ??
      []) as Selection[]) {
      const r = recordings.get(`${s.recording_span_id}/${s.recording_id}`);
      expect(r?.state, `${event.span.name}: unknown recording`).toBe("ready");
      expect(s.channel_index).toBe(event.span.name!.startsWith("user") ? 0 : 1);
      expect(s.start_offset_ms).toBeGreaterThanOrEqual(0);
      expect(s.end_offset_ms).toBeGreaterThan(s.start_offset_ms);
      expect(s.end_offset_ms).toBeLessThanOrEqual(
        r!.duration_ms + 1000 / r!.sample_rate_hz,
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
      expect([
        "input_context",
        "requested_by",
        "consumes_tool_result",
        "generated_by",
        "transcribed_by",
      ]).toContain(link.attributes["braintrust.relationship.type"]);
    }
  return events;
}
