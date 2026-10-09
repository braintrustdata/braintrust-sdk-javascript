import { expect, test } from "vitest";
import { TurnTracker } from "./turns";

test("duplex partial and final transcripts update the same turn during overlapping output", () => {
  const tracker = new TurnTracker(100);
  const first = tracker.start(1000);
  expect(
    tracker.transcript(
      { id: "u1", text: "Where", start: 1000, final: false },
      1100,
    ).id,
  ).toBe(first.id);
  tracker.stop(1400);
  const second = tracker.start(2000);
  tracker.transcript(
    { id: "u2", text: "Thank you", start: 2000, final: false },
    2100,
  );
  expect(
    tracker.transcript(
      { id: "u1", text: "Where is order 1042?", start: 1000, final: true },
      2200,
    ),
  ).toMatchObject({ id: first.id, text: "Where is order 1042?", end: 1400 });
  expect(tracker.current()?.id).toBe(second.id);
});

test("late final-only transcripts use their timestamp, not arrival order", () => {
  const tracker = new TurnTracker(100);
  const first = tracker.start(1000);
  tracker.stop(1500);
  const second = tracker.start(2000);
  tracker.stop(2500);
  expect(
    tracker.transcript(
      { id: "u2", text: "Second", start: 2000, final: true },
      3000,
    ).id,
  ).toBe(second.id);
  expect(
    tracker.transcript(
      { id: "u1", text: "First", start: 1000, final: true },
      3100,
    ).id,
  ).toBe(first.id);
});

test("ambiguous transcripts do not claim an arbitrary speech interval", () => {
  const tracker = new TurnTracker(100);
  const first = tracker.start(1000);
  tracker.stop(1500);
  const second = tracker.start(2000);
  tracker.stop(2500);
  const message = tracker.transcript(
    { id: "late", text: "Unassociated", final: true },
    3000,
  );
  expect([first.id, second.id]).not.toContain(message.id);
  expect(message.start).toBe(3000);
  expect(
    tracker.transcript({ id: "late", text: "Updated", final: true }, 3100).id,
  ).toBe(message.id);
});

test("shutdown marks only unfinished speech incomplete", () => {
  const tracker = new TurnTracker(100);
  tracker.start(1000);
  tracker.stop(1500);
  const active = tracker.start(2000);
  expect(tracker.close(2500)).toEqual([
    { ...active, end: 2500, incomplete: true },
  ]);
  expect(tracker.current()).toBeUndefined();
});

test("groups speech fragments across pauses up to 1.5 seconds and replaces partial text", () => {
  const tracker = new TurnTracker();
  const first = tracker.start(1000);
  tracker.transcript({ id: "a", text: "Where is", final: false }, 1100);
  tracker.transcript({ id: "a", text: "Where is my order", final: true }, 1200);
  tracker.stop(1500);
  expect(tracker.start(3000).id).toBe(first.id);
  tracker.transcript({ id: "b", text: " DMO", final: true }, 3100);
  tracker.stop(3200);
  expect(tracker.start(3300).id).toBe(first.id);
  expect(
    tracker.transcript({ id: "c", text: "1042?", final: true }, 3400).text,
  ).toBe("Where is my order DMO1042?");
  tracker.stop(3500);
  expect(first.end).toBe(3500);
  expect(tracker.start(5001).id).not.toBe(first.id);
  expect(
    tracker.transcript({ id: "b", text: " DEMO", final: true }, 5100).text,
  ).toBe("Where is my order DEMO1042?");
});

test("the caller pause window is configurable", () => {
  const tracker = new TurnTracker(500);
  const first = tracker.start(0);
  tracker.stop(100);
  expect(tracker.start(601).id).not.toBe(first.id);
});

test("assistant completion during caller speech or before its last stop does not split fragments", () => {
  const tracker = new TurnTracker(3000);
  const first = tracker.start(1000);
  tracker.boundary(1200);
  tracker.stop(1500);
  tracker.boundary(1400);
  expect(tracker.start(1700).id).toBe(first.id);
});
