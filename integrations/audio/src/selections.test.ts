import { expect, test } from "vitest";
import {
  mergeSelections,
  segmentSelections,
  type Selection,
} from "./selections";
const range = (start: number, end: number): Selection => ({
  recording_span_id: "root",
  recording_id: "call",
  channel_index: 1,
  start_offset_ms: start,
  end_offset_ms: end,
});
test("compaction preserves recording identities, channels and real discontinuities", () => {
  const result = mergeSelections([
    range(20, 40),
    range(0, 20),
    range(50, 60),
    { ...range(40, 50), recording_id: "other" },
    { ...range(40, 50), recording_span_id: "another-root" },
    { ...range(40, 50), channel_index: 0 },
  ]);
  expect(result).toHaveLength(5);
  expect(result).toContainEqual(range(0, 40));
  expect(result).toContainEqual(range(50, 60));
});
test("thirty minutes of contiguous frames scale with files, not frames", () => {
  const minutes = 30;
  const ranges = Array.from({ length: minutes * 60 * 50 }, (_, i) =>
    range(i * 20, (i + 1) * 20),
  );
  const merged = mergeSelections(ranges);
  expect(merged).toEqual([range(0, minutes * 60000)]);
  const segments = Array.from({ length: minutes }, (_, i) => ({
    id: `call-${i}`,
    start: i * 60000,
    end: (i + 1) * 60000,
    state: "ready" as const,
    channels: [1],
  }));
  expect(segmentSelections(merged, segments)).toHaveLength(minutes);
});

test("pending and failed segments never produce selections; a crossing turn uses local file coordinates", () => {
  const selections = segmentSelections(
    [
      {
        recording_span_id: "root",
        recording_id: "call",
        channel_index: 0,
        start_offset_ms: 29000,
        end_offset_ms: 32000,
      },
    ],
    [
      { id: "first", start: 0, end: 30000, state: "ready", channels: [0] },
      { id: "second", start: 30000, end: 60000, state: "ready", channels: [0] },
      { id: "pending", start: 0, end: 60000, state: "pending", channels: [0] },
      { id: "failed", start: 0, end: 60000, state: "omitted", channels: [0] },
    ],
  );
  expect(
    selections.map((s) => [s.recording_id, s.start_offset_ms, s.end_offset_ms]),
  ).toEqual([
    ["first", 29000, 30000],
    ["second", 0, 2000],
  ]);
});
