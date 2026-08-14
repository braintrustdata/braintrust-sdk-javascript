import { describe, expect, test } from "vitest";

import {
  isTraceFlagsSampled,
  normalizeTraceFlags,
  shouldSampleTraceId,
  validateSampleRate,
} from "./sampling";

describe("validateSampleRate", () => {
  test.each([0, 0.2, 1])("accepts %s", (sampleRate) => {
    expect(validateSampleRate(sampleRate)).toBe(sampleRate);
  });

  test.each([-1, 1.1, NaN, Infinity, -Infinity, null, "0.5"])(
    "rejects %j",
    (sampleRate) => {
      expect(() => validateSampleRate(sampleRate)).toThrow(RangeError);
    },
  );
});

describe("shouldSampleTraceId", () => {
  test("handles exact endpoints", () => {
    expect(shouldSampleTraceId("0".repeat(32), 0)).toBe(false);
    expect(shouldSampleTraceId("0".repeat(32), 1)).toBe(true);
  });

  test.each([
    [0.5, "0000000000000000007fffffffffffff", false],
    [0.5, "00000000000000000080000000000000", true],
    [0.25, "000000000000000000bfffffffffffff", false],
    [0.25, "000000000000000000c0000000000000", true],
  ])("uses exact boundary at rate %s", (rate, traceId, expected) => {
    expect(shouldSampleTraceId(traceId, rate)).toBe(expected);
  });

  test("normalizes legacy UUID trace ids", () => {
    expect(
      shouldSampleTraceId("00000000-0000-0000-0080-000000000000", 0.5),
    ).toBe(true);
  });
});

describe("trace flags", () => {
  test("preserves raw bits while inspecting sampled bit", () => {
    expect(normalizeTraceFlags("FF")).toBe("ff");
    expect(isTraceFlagsSampled("02")).toBe(false);
    expect(isTraceFlagsSampled("03")).toBe(true);
  });
});
