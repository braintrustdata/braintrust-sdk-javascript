import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { UUIDGenerator, OTELIDGenerator, getIdGenerator } from "./id-gen";
import { configureNode } from "./node/config";

configureNode();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isHex(s: string): boolean {
  return /^[0-9a-f]+$/.test(s);
}

describe("ID Generation", () => {
  describe("UUIDGenerator", () => {
    test("implements IDGenerator interface and generates valid UUIDs", () => {
      const generator = new UUIDGenerator();

      // UUID generators should share root_span_id for backwards compatibility
      expect(generator.shareRootSpanId()).toBe(true);

      const spanId1 = generator.getSpanId();
      const spanId2 = generator.getSpanId();
      expect(spanId1).not.toBe(spanId2);
      expect(spanId1).toMatch(UUID_RE);
      expect(spanId2).toMatch(UUID_RE);

      const traceId1 = generator.getTraceId();
      const traceId2 = generator.getTraceId();
      expect(traceId1).not.toBe(traceId2);
      expect(traceId1).toMatch(UUID_RE);
      expect(traceId2).toMatch(UUID_RE);
    });
  });

  describe("OTELIDGenerator", () => {
    test("generates W3C-shaped hex ids and does not share root span id", () => {
      const generator = new OTELIDGenerator();

      expect(generator.shareRootSpanId()).toBe(false);

      const spanId = generator.getSpanId();
      expect(spanId.length).toBe(16); // 8 bytes hex
      expect(isHex(spanId)).toBe(true);

      const traceId = generator.getTraceId();
      expect(traceId.length).toBe(32); // 16 bytes hex
      expect(isHex(traceId)).toBe(true);
    });
  });

  describe("getIdGenerator env selection", () => {
    let prevLegacy: string | undefined;
    let prevOtel: string | undefined;

    beforeEach(() => {
      prevLegacy = process.env.BRAINTRUST_LEGACY_IDS;
      prevOtel = process.env.BRAINTRUST_OTEL_COMPAT;
      delete process.env.BRAINTRUST_LEGACY_IDS;
      delete process.env.BRAINTRUST_OTEL_COMPAT;
    });

    afterEach(() => {
      if (prevLegacy === undefined) {
        delete process.env.BRAINTRUST_LEGACY_IDS;
      } else {
        process.env.BRAINTRUST_LEGACY_IDS = prevLegacy;
      }
      if (prevOtel === undefined) {
        delete process.env.BRAINTRUST_OTEL_COMPAT;
      } else {
        process.env.BRAINTRUST_OTEL_COMPAT = prevOtel;
      }
    });

    test("defaults to hex ids (no env vars)", () => {
      const generator = getIdGenerator();
      expect(generator.shareRootSpanId()).toBe(false);
      expect(isHex(generator.getSpanId())).toBe(true);
      expect(isHex(generator.getTraceId())).toBe(true);
    });

    test.each(["true", "True", "TRUE", "1", "yes", "on"])(
      "BRAINTRUST_OTEL_COMPAT=%s -> hex",
      (value) => {
        process.env.BRAINTRUST_OTEL_COMPAT = value;
        const generator = getIdGenerator();
        expect(isHex(generator.getSpanId())).toBe(true);
        expect(generator.shareRootSpanId()).toBe(false);
      },
    );

    test.each(["true", "True", "1"])(
      "BRAINTRUST_LEGACY_IDS=%s -> UUID",
      (value) => {
        process.env.BRAINTRUST_LEGACY_IDS = value;
        const generator = getIdGenerator();
        expect(generator.getSpanId()).toMatch(UUID_RE);
        expect(generator.shareRootSpanId()).toBe(true);
      },
    );

    test("BRAINTRUST_LEGACY_IDS=false -> hex", () => {
      process.env.BRAINTRUST_LEGACY_IDS = "false";
      const generator = getIdGenerator();
      expect(isHex(generator.getSpanId())).toBe(true);
    });

    test("OTEL_COMPAT wins over LEGACY_IDS when both set", () => {
      process.env.BRAINTRUST_OTEL_COMPAT = "true";
      process.env.BRAINTRUST_LEGACY_IDS = "true";
      const generator = getIdGenerator();
      expect(generator.shareRootSpanId()).toBe(false);
      expect(isHex(generator.getSpanId())).toBe(true);
    });
  });
});
