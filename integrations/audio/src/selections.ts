import { msToSamples, samplesToMs } from "./timeline";
import type { Segment } from "./segment";
export type Selection = {
  recording_span_id: string;
  recording_id: string;
  start_offset_ms: number;
  end_offset_ms: number;
  channel_index: number;
};
export function segmentSelections(
  intervals: Selection[],
  segments: readonly Segment[],
): Selection[] {
  return segments
    .filter((s) => s.state === "ready")
    .flatMap((segment) =>
      intervals
        .map((s) => ({
          ...s,
          recording_id: segment.id,
          start_offset_ms: Math.max(
            0,
            samplesToMs(
              Math.round(msToSamples(s.start_offset_ms - segment.start)),
            ),
          ),
          end_offset_ms: Math.min(
            segment.end - segment.start,
            samplesToMs(
              Math.round(msToSamples(s.end_offset_ms - segment.start)),
            ),
          ),
        }))
        .filter((s) => s.end_offset_ms > s.start_offset_ms),
    );
}

export function mergeSelections(ranges: Selection[]): Selection[] {
  const out: Selection[] = [];
  for (const r of [...ranges].sort(
    (a, b) =>
      a.recording_span_id.localeCompare(b.recording_span_id) ||
      a.recording_id.localeCompare(b.recording_id) ||
      a.channel_index - b.channel_index ||
      a.start_offset_ms - b.start_offset_ms,
  )) {
    const previous = out.at(-1);
    if (
      previous &&
      previous.recording_span_id === r.recording_span_id &&
      previous.recording_id === r.recording_id &&
      previous.channel_index === r.channel_index &&
      previous.end_offset_ms >= r.start_offset_ms - samplesToMs(1)
    ) {
      previous.end_offset_ms = Math.max(
        previous.end_offset_ms,
        r.end_offset_ms,
      );
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
