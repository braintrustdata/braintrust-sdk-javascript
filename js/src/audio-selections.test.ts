import { expect, test } from "vite-plus/test";
import { audioSelections } from "./audio-selections";

test("intervals become whole-millisecond selections, in timeline order", () => {
  expect(
    audioSelections([
      { start: 280.4, end: 290.6 },
      { start: 10, end: 20 },
    ]),
  ).toEqual({
    "selection-0": { start_offset_ms: 10, end_offset_ms: 20 },
    "selection-1": { start_offset_ms: 280, end_offset_ms: 291 },
  });
});

test("overlapping and touching intervals merge; empty ones are dropped", () => {
  expect(
    audioSelections([
      { start: 50.4, end: 120.2 },
      { start: 120.2, end: 250.6 }, // Touches the previous one.
      { start: 200, end: 230 }, // Inside the merged one.
      { start: 260, end: 260 }, // Empty.
      { start: 300.2, end: 300.4 }, // Empty once rounded.
    ]),
  ).toEqual({ "selection-0": { start_offset_ms: 50, end_offset_ms: 251 } });
});

test("no intervals means no selections", () => {
  expect(audioSelections([])).toBeUndefined();
  expect(audioSelections([{ start: 5, end: 5 }])).toBeUndefined();
});
