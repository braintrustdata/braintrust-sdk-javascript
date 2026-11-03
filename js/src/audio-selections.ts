/** An observed interval on the session timeline, in milliseconds from its origin. */
type AudioInterval = { start: number; end: number };

type AudioSelection = { start_offset_ms: number; end_offset_ms: number };

/**
 * A span's `audio.selections`: its intervals on the session timeline in whole
 * milliseconds, merged where they overlap or touch, in timeline order.
 */
export function audioSelections(
  intervals: AudioInterval[],
): Record<string, AudioSelection> | undefined {
  const merged: AudioSelection[] = [];
  for (const interval of intervals
    .map(({ start, end }) => ({
      start_offset_ms: Math.round(start),
      end_offset_ms: Math.round(end),
    }))
    .filter((s) => s.end_offset_ms > s.start_offset_ms)
    .sort((a, b) => a.start_offset_ms - b.start_offset_ms)) {
    const last = merged.at(-1);
    if (last && interval.start_offset_ms <= last.end_offset_ms)
      last.end_offset_ms = Math.max(last.end_offset_ms, interval.end_offset_ms);
    else merged.push(interval);
  }
  if (!merged.length) return;
  return Object.fromEntries(
    merged.map((selection, index) => [`selection-${index}`, selection]),
  );
}
