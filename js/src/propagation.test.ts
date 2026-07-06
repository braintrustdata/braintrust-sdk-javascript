/* eslint-disable @typescript-eslint/consistent-type-assertions */

/**
 * Tests for native W3C trace-context propagation.
 *
 * Mirrors the Braintrust distributed-tracing spec's test matrix using the pure
 * propagation path (no `@opentelemetry/api` dependency).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  _exportsForTestingOnly,
  _injectIntoCarrier,
  extractTraceContextFromHeaders,
  initLogger,
  injectTraceContext,
  startSpan,
} from "./logger";
import {
  BAGGAGE_HEADER,
  BRAINTRUST_PARENT_KEY,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  formatTraceparent,
  getHeader,
  isValidTracestate,
  mergeBaggage,
  parseBaggage,
  parseTraceparent,
} from "./propagation";
import { SpanComponentsV3 } from "../util/span_identifier_v3";
import { SpanComponentsV4 } from "../util/span_identifier_v4";
import { SpanObjectTypeV3 } from "../util/index";
import { configureNode } from "./node/config";
import { v4 as uuidv4 } from "uuid";

configureNode();

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

const VALID_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const VALID_SPAN_ID = "00f067aa0ba902b7";
const VALID_TRACEPARENT = `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`;

// --------------------------------------------------------------------------- //
// Primitives: traceparent / baggage parse + format
// --------------------------------------------------------------------------- //

describe("traceparent", () => {
  test("parse valid", () => {
    expect(parseTraceparent(VALID_TRACEPARENT)).toEqual({
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID,
      traceFlags: "01",
    });
  });

  test("parse strips whitespace", () => {
    expect(parseTraceparent(`  ${VALID_TRACEPARENT}  `)).toEqual({
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID,
      traceFlags: "01",
    });
  });

  test.each([
    "",
    null,
    undefined,
    "invalid",
    "00-tooshort-00f067aa0ba902b7-01",
    `00-${VALID_TRACE_ID}-00f067aa-01`, // short span id
    `99-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`, // bad version
    `00-${"0".repeat(32)}-${VALID_SPAN_ID}-01`, // zero trace id
    `00-${VALID_TRACE_ID}-${"0".repeat(16)}-01`, // zero span id
    `00-${VALID_TRACE_ID.toUpperCase()}-${VALID_SPAN_ID}-01`, // uppercase hex
  ])("parse invalid: %s", (value) => {
    expect(parseTraceparent(value as string)).toBeUndefined();
  });

  test("format round trip", () => {
    const tp = formatTraceparent(VALID_TRACE_ID, VALID_SPAN_ID)!;
    expect(tp).toMatch(TRACEPARENT_RE);
    expect(parseTraceparent(tp)).toEqual({
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID,
      traceFlags: "01",
    });
  });

  test("format rejects non-hex", () => {
    expect(formatTraceparent("not-hex", VALID_SPAN_ID)).toBeUndefined();
    expect(formatTraceparent(VALID_TRACE_ID, "00000000-0000")).toBeUndefined();
    expect(formatTraceparent("0".repeat(32), VALID_SPAN_ID)).toBeUndefined();
  });

  test("parse reports trace flags", () => {
    // The raw trace-flags byte must be recoverable so it can be carried through
    // extract -> inject. A not-sampled (`-00`) inbound trace must not be
    // silently upgraded to sampled.
    expect(
      parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`)?.traceFlags,
    ).toBe("01");
    expect(
      parseTraceparent(`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-00`)?.traceFlags,
    ).toBe("00");
  });

  test("format preserves flags round trip", () => {
    const parsed = parseTraceparent(
      `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-00`,
    )!;
    const tp = formatTraceparent(
      VALID_TRACE_ID,
      VALID_SPAN_ID,
      parsed.traceFlags,
    )!;
    expect(tp.endsWith("-00")).toBe(true);
    expect(parseTraceparent(tp)?.traceFlags).toBe("00");
  });

  test("format defaults to sampled", () => {
    expect(
      formatTraceparent(VALID_TRACE_ID, VALID_SPAN_ID)?.endsWith("-01"),
    ).toBe(true);
  });

  test("format falls back on bad flags", () => {
    expect(
      formatTraceparent(VALID_TRACE_ID, VALID_SPAN_ID, "zz")?.endsWith("-01"),
    ).toBe(true);
  });
});

describe("baggage", () => {
  test("parse simple", () => {
    expect(parseBaggage("braintrust.parent=project_id:abc")).toEqual({
      "braintrust.parent": "project_id:abc",
    });
  });

  test("parse preserves unrelated keys", () => {
    const parsed = parseBaggage(
      "foo=bar,braintrust.parent=project_id:abc,baz=qux",
    );
    expect(parsed["foo"]).toBe("bar");
    expect(parsed["baz"]).toBe("qux");
    expect(parsed["braintrust.parent"]).toBe("project_id:abc");
  });

  test("parse ignores properties", () => {
    expect(parseBaggage("k=v;prop=1")).toEqual({ k: "v" });
  });

  test.each(["", null, undefined, "no-equals", ",,,"])(
    "parse malformed does not throw: %s",
    (value) => {
      expect(parseBaggage(value as string)).toEqual({});
    },
  );

  test("parse oversized does not throw", () => {
    const big = "x=" + "a".repeat(100000);
    // A single member larger than the limit has no complete member to keep, so
    // it is dropped entirely (we never decode a partial value).
    expect(parseBaggage(big)).toEqual({});
  });

  test("parse oversized keeps whole members only", () => {
    const members = Array.from(
      { length: 200 },
      (_, i) => `k${i}=${"v".repeat(100)}`,
    );
    const header = members.join(",");
    const parsed = parseBaggage(header);
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    expect(Object.values(parsed).every((v) => v === "v".repeat(100))).toBe(
      true,
    );
    const keptKeys = Object.keys(parsed);
    expect(keptKeys).toEqual(keptKeys.map((_, i) => `k${i}`));
  });

  test("parse caps member count", () => {
    const header = Array.from({ length: 200 }, (_, i) => `k${i}=v`).join(",");
    const parsed = parseBaggage(header);
    expect(Object.keys(parsed).length).toBe(64);
    expect(Object.keys(parsed)).toEqual(
      Array.from({ length: 64 }, (_, i) => `k${i}`),
    );
  });

  test.each([
    [64, 64],
    [65, 64],
    [10, 10],
  ])("parse member count boundary: %i -> %i", (count, expected) => {
    const header = Array.from({ length: count }, (_, i) => `k${i}=v`).join(",");
    expect(Object.keys(parseBaggage(header)).length).toBe(expected);
  });

  test("parse decodes standard encoder values", () => {
    // Standard encoders (e.g. OpenTelemetry's propagator) percent-encode `:` as
    // `%3A`. We must fully decode inbound values to interoperate.
    expect(
      parseBaggage(`${BRAINTRUST_PARENT_KEY}=project_id%3Aabc123`),
    ).toEqual({ [BRAINTRUST_PARENT_KEY]: "project_id:abc123" });
  });
});

describe("isValidTracestate", () => {
  test.each([
    "congo=t61rcWkgMzE",
    "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7",
    "vendor@system=value",
    "a=b", // minimal single member
    `k=${"a".repeat(256)}`, // max value length
    "k=a b c", // spaces allowed mid-value
    Array.from({ length: 32 }, (_, i) => `k${i}=v`).join(","), // max members
  ])("accepts valid tracestate: %s", (value) => {
    expect(isValidTracestate(value)).toBe(true);
  });

  test.each([
    ["", "empty"],
    [null, "null"],
    [undefined, "undefined"],
    ["ConGo=t61", "uppercase key"],
    ["1congo=t61", "key must start with a letter"],
    ["congo=", "empty value"],
    ["congo=bad=value", "value cannot contain equals"],
    ["congo,rojo=v", "member missing equals"],
    ["congo=\u00e9", "non-ASCII value"],
    ["congo=a,congo=b", "duplicate key"],
    [`k=${"a".repeat(257)}`, "value too long"],
    [
      Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(","),
      "too many members",
    ],
    [`congo=${"a".repeat(513)}`, "over 512 chars total"],
  ])("rejects invalid tracestate (%s): %s", (value) => {
    expect(isValidTracestate(value as string)).toBe(false);
  });
});

describe("mergeBaggage", () => {
  test("adds braintrust parent when no existing", () => {
    const merged = mergeBaggage(null, "project_id:abc");
    expect(parseBaggage(merged)).toEqual({
      [BRAINTRUST_PARENT_KEY]: "project_id:abc",
    });
  });

  test("none parent and no existing returns undefined", () => {
    expect(mergeBaggage(null, null)).toBeUndefined();
    expect(mergeBaggage("", null)).toBeUndefined();
  });

  test("preserves unrelated baggage byte for byte", () => {
    const merged = mergeBaggage("path=a%2Fb,user=alice", "project_id:abc")!;
    expect(merged).toContain("path=a%2Fb");
    expect(merged).toContain("user=alice");
    // Our own value is percent-encoded for spec compliance (`:` -> `%3A`).
    expect(merged).toContain(`${BRAINTRUST_PARENT_KEY}=project_id%3Aabc`);
    expect(parseBaggage(merged)[BRAINTRUST_PARENT_KEY]).toBe("project_id:abc");
  });

  test("does not decode unowned percent sequences", () => {
    // `%41` is the percent-encoding of `A`. A transparent relay must not
    // collapse `a%41b` to `aAb`.
    expect(mergeBaggage("k=a%41b", null)).toBe("k=a%41b");
  });

  test.each([
    "a%2Fb", // `/` outside our encode set
    "x%3Ay", // `:` (what OTel encodes)
    "c%2Cd", // encoded comma
    "a%3Db", // encoded `=`
    "%C3%A9", // multi-byte UTF-8 (é) already percent-encoded
    "%2520", // a literal `%20` the upstream double-encoded
  ])("unowned value encodings pass through verbatim: %s", (value) => {
    expect(mergeBaggage(`vendor=${value}`, null)).toBe(`vendor=${value}`);
  });

  test("multiple unowned members pass through verbatim", () => {
    const inbound = "p1=a%2Fb,p2=x%3Ay,p3=c%2Cd";
    const merged = mergeBaggage(inbound, "project_id:p");
    expect(merged).toBe(`${inbound},${BRAINTRUST_PARENT_KEY}=project_id%3Ap`);
  });

  test("preserves member properties", () => {
    const merged = mergeBaggage("k=v;meta=1;ttl=30,vendor=y", null);
    expect(merged).toBe("k=v;meta=1;ttl=30,vendor=y");
  });

  test("empty value member is preserved", () => {
    expect(mergeBaggage("k=,vendor=y", null)).toBe("k=,vendor=y");
  });

  test("optional whitespace is trimmed", () => {
    const merged = mergeBaggage(" a=1 , b=2 ", "project_id:p");
    expect(merged).toBe(`a=1,b=2,${BRAINTRUST_PARENT_KEY}=project_id%3Ap`);
  });

  test("replaces existing braintrust parent", () => {
    const merged = mergeBaggage(
      `${BRAINTRUST_PARENT_KEY}=project_id:old,vendor=x`,
      "project_id:new",
    )!;
    const parsed = parseBaggage(merged);
    expect(parsed[BRAINTRUST_PARENT_KEY]).toBe("project_id:new");
    expect(parsed["vendor"]).toBe("x");
    expect(
      (merged.match(new RegExp(`${BRAINTRUST_PARENT_KEY}=`, "g")) || []).length,
    ).toBe(1);
  });

  test("drops existing braintrust parent when no new value", () => {
    const merged = mergeBaggage(
      `${BRAINTRUST_PARENT_KEY}=project_id:old,vendor=x`,
      null,
    );
    expect(merged).toBe("vendor=x");
  });

  test("encodes braintrust parent with reserved chars", () => {
    const merged = mergeBaggage(null, "project_name:a,b c");
    expect(parseBaggage(merged)).toEqual({
      [BRAINTRUST_PARENT_KEY]: "project_name:a,b c",
    });
  });

  test("omits oversized braintrust parent", () => {
    const oversizedParent = `project_name:${"a".repeat(9000)}`;
    expect(mergeBaggage(null, oversizedParent)).toBeUndefined();
    expect(mergeBaggage("vendor=x", oversizedParent)).toBe("vendor=x");
    expect(
      mergeBaggage(
        `${BRAINTRUST_PARENT_KEY}=project_id%3Aold,vendor=x`,
        oversizedParent,
      ),
    ).toBe("vendor=x");
  });

  // The braintrust.parent value embeds a user-controlled project/experiment
  // name. Per W3C Baggage §3.3.1.3 a value's unencoded bytes are restricted to
  // baggage-octet; everything else MUST be percent-encoded.
  test.each([
    'a"b', // DQUOTE
    "a\\b", // backslash
    "a\tb", // tab
    "a\nb", // newline
    "abcd\u00e9", // non-ASCII (é)
    "emoji\u{1f600}", // astral plane
    "a+b", // literal plus must stay a plus
    "a%b", // literal percent MUST be encoded
    "a,b c", // comma + space
    "a;b=c", // semicolon + equals
  ])("braintrust parent value round trips spec-compliant: %s", (name) => {
    const value = `project_name:${name}`;
    const merged = mergeBaggage(null, value)!;

    // Round-trip through the same decode path the SDK uses on receive.
    expect(parseBaggage(merged)).toEqual({ [BRAINTRUST_PARENT_KEY]: value });

    // ASCII only, and the braintrust.parent member carries no raw
    // baggage-octet violators.
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(merged)).toBe(true);
    const member = merged
      .split(",")
      .find((m) => m.startsWith(`${BRAINTRUST_PARENT_KEY}=`))!;
    const encodedVal = member.slice(member.indexOf("=") + 1);
    for (const ch of encodedVal) {
      const cp = ch.codePointAt(0)!;
      const allowed =
        cp === 0x21 ||
        (cp >= 0x23 && cp <= 0x2b) ||
        (cp >= 0x2d && cp <= 0x3a) ||
        (cp >= 0x3c && cp <= 0x5b) ||
        (cp >= 0x5d && cp <= 0x7e);
      expect(allowed).toBe(true);
    }
  });

  test("skips malformed existing members", () => {
    const merged = mergeBaggage("garbage,,k=v,no-equals", "project_id:abc")!;
    const parsed = parseBaggage(merged);
    expect(parsed["k"]).toBe("v");
    expect(parsed[BRAINTRUST_PARENT_KEY]).toBe("project_id:abc");
  });

  test("oversized existing relays whole members only", () => {
    const members = Array.from(
      { length: 200 },
      (_, i) => `k${i}=${"v".repeat(100)}`,
    );
    const existing = members.join(",");
    const merged = mergeBaggage(existing, "project_id:abc")!;
    const parsed = parseBaggage(merged);
    expect(new TextEncoder().encode(merged).length).toBeLessThanOrEqual(8192);
    expect(parsed[BRAINTRUST_PARENT_KEY]).toBe("project_id:abc");
    const relayed = Object.entries(parsed).filter(
      ([k]) => k !== BRAINTRUST_PARENT_KEY,
    );
    expect(relayed.length).toBeGreaterThan(0);
    expect(relayed.every(([, v]) => v === "v".repeat(100))).toBe(true);
    for (const member of merged.split(",")) {
      if (member.startsWith(`${BRAINTRUST_PARENT_KEY}=`)) {
        continue;
      }
      expect(member.endsWith("v".repeat(100))).toBe(true);
    }
  });

  test("caps member count and reserves slot for braintrust parent", () => {
    const existing = Array.from({ length: 200 }, (_, i) => `k${i}=v`).join(",");
    const merged = mergeBaggage(existing, "project_id:abc")!;
    const parsed = parseBaggage(merged);
    expect((merged.match(/,/g) || []).length + 1).toBe(64);
    expect(Object.keys(parsed).length).toBe(64);
    expect(parsed[BRAINTRUST_PARENT_KEY]).toBe("project_id:abc");
    const relayedKeys = Object.keys(parsed).filter(
      (k) => k !== BRAINTRUST_PARENT_KEY,
    );
    expect(relayedKeys).toEqual(Array.from({ length: 63 }, (_, i) => `k${i}`));
  });

  test("member count cap without braintrust parent", () => {
    const existing = Array.from({ length: 200 }, (_, i) => `k${i}=v`).join(",");
    const merged = mergeBaggage(existing, null)!;
    const parsed = parseBaggage(merged);
    expect(Object.keys(parsed).length).toBe(64);
    expect(Object.keys(parsed)).toEqual(
      Array.from({ length: 64 }, (_, i) => `k${i}`),
    );
  });

  test("under member limit keeps all", () => {
    const existing = Array.from({ length: 10 }, (_, i) => `k${i}=v`).join(",");
    const merged = mergeBaggage(existing, "project_id:abc")!;
    const parsed = parseBaggage(merged);
    expect(Object.keys(parsed).length).toBe(11);
    expect(parsed[BRAINTRUST_PARENT_KEY]).toBe("project_id:abc");
  });
});

test("getHeader case insensitive", () => {
  const headers = { TraceParent: VALID_TRACEPARENT, BAGGAGE: "foo=bar" };
  expect(getHeader(headers, "traceparent")).toBe(VALID_TRACEPARENT);
  expect(getHeader(headers, "baggage")).toBe("foo=bar");
  expect(getHeader(headers, "missing")).toBeUndefined();
});

test("getHeader handles array-valued headers", () => {
  // Node's IncomingHttpHeaders can expose multi-valued headers as arrays.
  // traceparent is single-valued, while baggage and tracestate are list headers.
  const headers = {
    traceparent: [VALID_TRACEPARENT, "00-extra"],
    baggage: ["foo=bar", "team=eng"],
    tracestate: ["congo=t61", "rojo=00f"],
  };
  expect(getHeader(headers, "traceparent")).toBe(VALID_TRACEPARENT);
  expect(getHeader(headers, "baggage")).toBe("foo=bar,team=eng");
  expect(getHeader(headers, "tracestate")).toBe("congo=t61,rojo=00f");
  expect(getHeader({ traceparent: [] }, "traceparent")).toBeUndefined();
});

test("getHeader reads tuple-array headers", () => {
  const headers: [string, string][] = [
    ["TraceParent", VALID_TRACEPARENT],
    ["baggage", "foo=bar"],
    ["Baggage", "team=eng"],
  ];
  expect(getHeader(headers, "traceparent")).toBe(VALID_TRACEPARENT);
  expect(getHeader(headers, "baggage")).toBe("foo=bar,team=eng");
});

test("getHeader reads Node setHeader-style objects", () => {
  const headers = {
    getHeader(name: string) {
      const values: Record<string, string> = {
        traceparent: VALID_TRACEPARENT,
        baggage: "foo=bar",
      };
      return values[name.toLowerCase()];
    },
  };
  expect(getHeader(headers, "traceparent")).toBe(VALID_TRACEPARENT);
  expect(getHeader(headers, "baggage")).toBe("foo=bar");
});

test("getHeader skips a null case-variant and keeps searching", () => {
  // A null/absent value under one case must not stop the lookup from finding a
  // valid value under a different case-variant of the same header.
  const headers = { traceparent: null, Traceparent: VALID_TRACEPARENT };
  expect(getHeader(headers, "traceparent")).toBe(VALID_TRACEPARENT);
});

test("getHeader reads Web Headers-style objects", () => {
  const headers = {
    get(name: string) {
      return name === "traceparent" ? VALID_TRACEPARENT : null;
    },
  };
  expect(getHeader(headers, "traceparent")).toBe(VALID_TRACEPARENT);
  expect(getHeader(headers, "missing")).toBeUndefined();
});

// --------------------------------------------------------------------------- //
// Send / receive / round-trip against a live logger
// --------------------------------------------------------------------------- //

const PROJECT_NAME = "propagation-test";

describe("inject / extract / round-trip", () => {
  let memoryLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeEach(() => {
    _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.resetIdGenStateForTests();
    memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  function makeLogger() {
    return initLogger({ projectName: PROJECT_NAME });
  }

  describe("inject", () => {
    test("traceparent well-formed and matches span", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = span.inject({});
      span.end();

      const tp = carrier[TRACEPARENT_HEADER];
      expect(tp).toMatch(TRACEPARENT_RE);
      const parsed = parseTraceparent(tp)!;
      expect(parsed.traceId).toBe(span.rootSpanId);
      expect(parsed.spanId).toBe(span.spanId);
    });

    test("baggage contains braintrust parent", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = span.inject({});
      span.end();

      const parsed = parseBaggage(carrier[BAGGAGE_HEADER]);
      expect(parsed[BRAINTRUST_PARENT_KEY]).toBe(
        `project_name:${PROJECT_NAME}`,
      );
    });

    test("preexisting baggage preserved", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = span.inject({ [BAGGAGE_HEADER]: "user=alice,team=eng" });
      span.end();

      const parsed = parseBaggage(carrier[BAGGAGE_HEADER]);
      expect(parsed["user"]).toBe("alice");
      expect(parsed["team"]).toBe("eng");
      expect(parsed[BRAINTRUST_PARENT_KEY]).toBe(
        `project_name:${PROJECT_NAME}`,
      );
    });

    test("array-valued baggage is joined before merge", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = span.inject({
        [BAGGAGE_HEADER]: ["user=alice", "team=eng"],
      });
      span.end();

      const parsed = parseBaggage(carrier[BAGGAGE_HEADER]);
      expect(parsed["user"]).toBe("alice");
      expect(parsed["team"]).toBe("eng");
      expect(parsed[BRAINTRUST_PARENT_KEY]).toBe(
        `project_name:${PROJECT_NAME}`,
      );
    });

    test("title-cased baggage emits single lowercase header", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = span.inject({ Baggage: "user=alice" });
      span.end();

      const baggageKeys = Object.keys(carrier).filter(
        (k) => k.toLowerCase() === BAGGAGE_HEADER,
      );
      expect(baggageKeys).toEqual([BAGGAGE_HEADER]);
      const parsed = parseBaggage(carrier[BAGGAGE_HEADER]);
      expect(parsed["user"]).toBe("alice");
      expect(parsed[BRAINTRUST_PARENT_KEY]).toBe(
        `project_name:${PROJECT_NAME}`,
      );
    });

    test("title-cased traceparent emits single lowercase header", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = span.inject({ Traceparent: "stale" });
      span.end();

      const traceparentKeys = Object.keys(carrier).filter(
        (k) => k.toLowerCase() === TRACEPARENT_HEADER,
      );
      expect(traceparentKeys).toEqual([TRACEPARENT_HEADER]);
      const parsed = parseTraceparent(carrier[TRACEPARENT_HEADER])!;
      expect(parsed.traceId).toBe(span.rootSpanId);
      expect(parsed.spanId).toBe(span.spanId);
    });

    test("never emits x-bt-parent", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = span.inject({});
      span.end();
      expect(Object.keys(carrier).map((k) => k.toLowerCase())).not.toContain(
        "x-bt-parent",
      );
    });

    test("injects into Web Headers-style objects", () => {
      const HeadersCtor = (
        globalThis as unknown as {
          Headers?: new (init?: Record<string, string>) => {
            get(name: string): string | null;
            set(name: string, value: string): void;
          };
        }
      ).Headers;
      if (!HeadersCtor) {
        return;
      }

      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = new HeadersCtor({ Baggage: "user=alice" });
      const returned = span.inject(carrier);
      span.end();

      expect(returned).toBe(carrier);
      expect(carrier.get(TRACEPARENT_HEADER)).toMatch(TRACEPARENT_RE);
      expect(parseBaggage(carrier.get(BAGGAGE_HEADER))).toEqual({
        user: "alice",
        [BRAINTRUST_PARENT_KEY]: `project_name:${PROJECT_NAME}`,
      });
    });

    test("injects into tuple-array headers", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier: [string, string][] = [["Baggage", "user=alice"]];
      const returned = span.inject(carrier);
      span.end();

      expect(returned).toBe(carrier);
      expect(getHeader(carrier, TRACEPARENT_HEADER)).toMatch(TRACEPARENT_RE);
      expect(getHeader(carrier, BAGGAGE_HEADER)).not.toBeUndefined();
      expect(
        carrier.filter(([key]) => key.toLowerCase() === BAGGAGE_HEADER),
      ).toHaveLength(1);
      expect(parseBaggage(getHeader(carrier, BAGGAGE_HEADER))).toEqual({
        user: "alice",
        [BRAINTRUST_PARENT_KEY]: `project_name:${PROJECT_NAME}`,
      });
    });

    test("injects into Node setHeader-style objects", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = {
        values: { Baggage: "user=alice" } as Record<string, string>,
        getHeader(name: string) {
          const lowered = name.toLowerCase();
          for (const key of Object.keys(this.values)) {
            if (key.toLowerCase() === lowered) {
              return this.values[key];
            }
          }
          return undefined;
        },
        setHeader(name: string, value: string) {
          this.values[name] = value;
        },
        removeHeader(name: string) {
          const lowered = name.toLowerCase();
          for (const key of Object.keys(this.values)) {
            if (key.toLowerCase() === lowered) {
              delete this.values[key];
            }
          }
        },
      };
      const returned = span.inject(carrier);
      span.end();

      expect(returned).toBe(carrier);
      expect(carrier.values[TRACEPARENT_HEADER]).toMatch(TRACEPARENT_RE);
      expect("Baggage" in carrier.values).toBe(false);
      expect(parseBaggage(carrier.values[BAGGAGE_HEADER])).toEqual({
        user: "alice",
        [BRAINTRUST_PARENT_KEY]: `project_name:${PROJECT_NAME}`,
      });
    });

    test("injects into header-style response objects", () => {
      const logger = makeLogger();
      const span = logger.startSpan({ name: "svc_a" });
      const carrier = {
        values: { Baggage: "user=alice" } as Record<string, string>,
        getHeader(name: string) {
          const lowered = name.toLowerCase();
          for (const key of Object.keys(this.values)) {
            if (key.toLowerCase() === lowered) {
              return this.values[key];
            }
          }
          return undefined;
        },
        header(name: string, value: string) {
          this.values[name] = value;
        },
        removeHeader(name: string) {
          const lowered = name.toLowerCase();
          for (const key of Object.keys(this.values)) {
            if (key.toLowerCase() === lowered) {
              delete this.values[key];
            }
          }
        },
      };
      const returned = span.inject(carrier);
      span.end();

      expect(returned).toBe(carrier);
      expect(carrier.values[TRACEPARENT_HEADER]).toMatch(TRACEPARENT_RE);
      expect("Baggage" in carrier.values).toBe(false);
      expect(parseBaggage(carrier.values[BAGGAGE_HEADER])).toEqual({
        user: "alice",
        [BRAINTRUST_PARENT_KEY]: `project_name:${PROJECT_NAME}`,
      });
    });

    test("no braintrust parent injects traceparent without baggage", () => {
      const carrier: Record<string, string> = {};
      _injectIntoCarrier(carrier, {
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        braintrustParent: undefined,
      });
      expect(carrier[TRACEPARENT_HEADER]).toMatch(TRACEPARENT_RE);
      expect(BAGGAGE_HEADER in carrier).toBe(false);
    });

    test("no braintrust parent preserves existing baggage without bt key", () => {
      const carrier: Record<string, string> = {
        [BAGGAGE_HEADER]: "user=alice",
      };
      _injectIntoCarrier(carrier, {
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        braintrustParent: undefined,
      });
      const parsed = parseBaggage(carrier[BAGGAGE_HEADER]);
      expect(parsed["user"]).toBe("alice");
      expect(BRAINTRUST_PARENT_KEY in parsed).toBe(false);
    });

    test("no braintrust parent removes stale braintrust baggage", () => {
      const carrier: Record<string, string> = {
        Baggage: `${BRAINTRUST_PARENT_KEY}=project_id%3Aold`,
      };
      _injectIntoCarrier(carrier, {
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID,
        braintrustParent: undefined,
      });
      expect(carrier[TRACEPARENT_HEADER]).toMatch(TRACEPARENT_RE);
      expect(
        Object.keys(carrier).map((key) => key.toLowerCase()),
      ).not.toContain(BAGGAGE_HEADER);
    });

    test("injectTraceContext free function", () => {
      const logger = makeLogger();
      let captured: { root: string; span: string } | undefined;
      let carrier: Record<string, string> = {};
      logger.traced(
        (span) => {
          carrier = injectTraceContext();
          captured = { root: span.rootSpanId, span: span.spanId };
        },
        { name: "svc_a" },
      );
      const parsed = parseTraceparent(carrier[TRACEPARENT_HEADER])!;
      expect(parsed.traceId).toBe(captured!.root);
      expect(parsed.spanId).toBe(captured!.span);
    });

    test("inject no current span is safe", () => {
      const carrier = injectTraceContext({});
      expect(TRACEPARENT_HEADER in carrier).toBe(false);
    });
  });

  describe("extract", () => {
    test("traceparent with baggage parent", () => {
      const logger = makeLogger();
      const ctx = extractTraceContextFromHeaders({
        traceparent: VALID_TRACEPARENT,
        baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc123`,
      });
      const span = logger.startSpan({ name: "h", parent: ctx });
      expect(span.rootSpanId).toBe(VALID_TRACE_ID);
      expect(span.spanParents).toEqual([VALID_SPAN_ID]);
      span.end();
    });

    test("traceparent baggage with unrelated keys", () => {
      const logger = makeLogger();
      const ctx = extractTraceContextFromHeaders({
        traceparent: VALID_TRACEPARENT,
        baggage: `user=alice,${BRAINTRUST_PARENT_KEY}=project_id:abc,team=eng`,
      });
      const span = logger.startSpan({ name: "h", parent: ctx });
      expect(span.rootSpanId).toBe(VALID_TRACE_ID);
      expect(span.spanParents).toEqual([VALID_SPAN_ID]);
      span.end();
    });

    test("traceparent no baggage uses current logger", () => {
      const logger = makeLogger();
      const ctx = extractTraceContextFromHeaders({
        traceparent: VALID_TRACEPARENT,
      });
      expect(ctx).not.toBeUndefined();
      const span = logger.startSpan({ name: "h", parent: ctx });
      expect(span.rootSpanId).toBe(VALID_TRACE_ID);
      expect(span.spanParents).toEqual([VALID_SPAN_ID]);
      span.end();
    });

    test("no headers returns undefined", () => {
      expect(extractTraceContextFromHeaders({})).toBeUndefined();
      expect(extractTraceContextFromHeaders(null)).toBeUndefined();
      expect(extractTraceContextFromHeaders(undefined)).toBeUndefined();
    });

    test("malformed traceparent returns undefined", () => {
      expect(
        extractTraceContextFromHeaders({
          traceparent: "garbage",
          baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
        }),
      ).toBeUndefined();
    });

    test("case insensitive headers", () => {
      const logger = makeLogger();
      const ctx = extractTraceContextFromHeaders({
        TraceParent: VALID_TRACEPARENT,
        Baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
      });
      const span = logger.startSpan({ name: "h", parent: ctx });
      expect(span.rootSpanId).toBe(VALID_TRACE_ID);
      expect(span.spanParents).toEqual([VALID_SPAN_ID]);
      span.end();
    });

    test("Node-style array headers", () => {
      const logger = makeLogger();
      const ctx = extractTraceContextFromHeaders({
        traceparent: [VALID_TRACEPARENT, "00-extra"],
        baggage: [`${BRAINTRUST_PARENT_KEY}=project_id:abc`],
        tracestate: ["congo=t61"],
      });
      const span = logger.startSpan({ name: "h", parent: ctx });
      expect(span.rootSpanId).toBe(VALID_TRACE_ID);
      expect(span.spanParents).toEqual([VALID_SPAN_ID]);
      span.end();
    });

    test("Web Headers-style getter object", () => {
      const logger = makeLogger();
      const headers = {
        get(name: string) {
          const values: Record<string, string> = {
            traceparent: VALID_TRACEPARENT,
            baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
          };
          return values[name] ?? null;
        },
      };
      const ctx = extractTraceContextFromHeaders(headers);
      const span = logger.startSpan({ name: "h", parent: ctx });
      expect(span.rootSpanId).toBe(VALID_TRACE_ID);
      expect(span.spanParents).toEqual([VALID_SPAN_ID]);
      span.end();
    });

    test("native Headers object when available", () => {
      const HeadersCtor = (
        globalThis as unknown as {
          Headers?: new (init?: Record<string, string>) => {
            get(name: string): string | null;
          };
        }
      ).Headers;
      if (!HeadersCtor) {
        return;
      }

      const logger = makeLogger();
      const ctx = extractTraceContextFromHeaders(
        new HeadersCtor({
          traceparent: VALID_TRACEPARENT,
          baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
        }),
      );
      const span = logger.startSpan({ name: "h", parent: ctx });
      expect(span.rootSpanId).toBe(VALID_TRACE_ID);
      expect(span.spanParents).toEqual([VALID_SPAN_ID]);
      span.end();
    });

    test("extract returns opaque dict", () => {
      const ctx = extractTraceContextFromHeaders({
        traceparent: VALID_TRACEPARENT,
        baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
        tracestate: "congo=t61",
      })!;
      expect(typeof ctx).toBe("object");
      expect(ctx[TRACEPARENT_HEADER]).toBe(VALID_TRACEPARENT);
    });

    test("no parent and logger present starts span without throwing", () => {
      const logger = makeLogger();
      const ctx = extractTraceContextFromHeaders({
        traceparent: VALID_TRACEPARENT,
      });
      const span = logger.startSpan({ name: "h", parent: ctx });
      expect(span.spanId).not.toBeUndefined();
      span.end();
    });
  });

  test("round trip inject extract", () => {
    const logger = makeLogger();
    const spanA = logger.startSpan({ name: "svc_a" });
    const carrier = spanA.inject({});
    const aRoot = spanA.rootSpanId;
    const aSpan = spanA.spanId;
    spanA.end();

    const parent = extractTraceContextFromHeaders(carrier);
    const spanB = logger.startSpan({ name: "svc_b", parent });
    expect(spanB.rootSpanId).toBe(aRoot);
    expect(spanB.spanParents).toEqual([aSpan]);
    spanB.end();
  });

  test("top-level propagated project_id parent is re-injected before lazy id resolves", () => {
    makeLogger();
    const parent = extractTraceContextFromHeaders({
      traceparent: VALID_TRACEPARENT,
      baggage: `${BRAINTRUST_PARENT_KEY}=project_id:remote-project-id`,
    });
    const span = startSpan({ name: "svc_b", parent });
    const carrier = span.inject({});
    span.end();

    expect(parseBaggage(carrier[BAGGAGE_HEADER])).toEqual({
      [BRAINTRUST_PARENT_KEY]: "project_id:remote-project-id",
    });
  });

  test("top-level propagated experiment_id parent is re-injected before lazy id resolves", () => {
    makeLogger();
    const parent = extractTraceContextFromHeaders({
      traceparent: VALID_TRACEPARENT,
      baggage: `${BRAINTRUST_PARENT_KEY}=experiment_id:remote-experiment-id`,
    });
    const span = startSpan({ name: "svc_b", parent });
    const carrier = span.inject({});
    span.end();

    expect(parseBaggage(carrier[BAGGAGE_HEADER])).toEqual({
      [BRAINTRUST_PARENT_KEY]: "experiment_id:remote-experiment-id",
    });
  });

  test("logger method links inbound trace but propagates current project", () => {
    const logger = initLogger({
      projectName: PROJECT_NAME,
      projectId: "current-project-id",
    });
    const parent = extractTraceContextFromHeaders({
      traceparent: VALID_TRACEPARENT,
      baggage: `${BRAINTRUST_PARENT_KEY}=project_id:remote-project-id`,
    });
    const span = logger.startSpan({ name: "svc_b", parent });
    const carrier = span.inject({});
    span.end();

    expect(span.rootSpanId).toBe(VALID_TRACE_ID);
    expect(span.spanParents).toEqual([VALID_SPAN_ID]);
    expect(parseBaggage(carrier[BAGGAGE_HEADER])).toEqual({
      [BRAINTRUST_PARENT_KEY]: "project_id:current-project-id",
    });
  });

  test("inject does not break span emission without parent", async () => {
    // inject is best-effort and must never drop the span. Use a projectId so
    // draining doesn't require a metadata round-trip.
    const logger = initLogger({
      projectName: "emit-test",
      projectId: "emit-test-project-id",
    });
    const span = logger.startSpan({ name: "svc_a" });
    span.inject({});
    span.log({ output: "hello" });
    span.end();
    await memoryLogger.flush();
    const events = (await memoryLogger.drain()) as any[];
    expect(events.some((e) => e["output"] === "hello")).toBe(true);
  });

  test("legacy export slug round trips with hex ids", () => {
    const logger = makeLogger();
    const parent = logger.startSpan({ name: "parent" });
    const pRoot = parent.rootSpanId;
    const pSpan = parent.spanId;
    parent.end();

    // Ids are OTEL-shaped hex by default.
    expect(pSpan.length).toBe(16);
    expect(pRoot.length).toBe(32);

    // Build a slug synchronously from the hex ids (mirrors span.export()).
    const slug = new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      compute_object_metadata_args: { project_name: PROJECT_NAME },
      row_id: "bt-row",
      span_id: pSpan,
      root_span_id: pRoot,
    }).toStr();

    const child = logger.startSpan({ name: "child", parent: slug });
    expect(child.rootSpanId).toBe(pRoot);
    expect(child.spanParents).toEqual([pSpan]);
    child.end();
  });

  test("legacy parent slug (UUID) linked in hex mode", () => {
    const logger = makeLogger();
    const pSpan = uuidv4();
    const pRoot = uuidv4();
    const legacySlug = new SpanComponentsV3({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "legacy-proj",
      row_id: uuidv4(),
      span_id: pSpan,
      root_span_id: pRoot,
    }).toStr();

    const child = logger.startSpan({ name: "child", parent: legacySlug });
    // Links to the slug's UUID ids; the child's own span id stays hex.
    expect(child.rootSpanId).toBe(pRoot);
    expect(child.spanParents).toEqual([pSpan]);
    expect(child.spanId.length).toBe(16);
    child.end();
  });

  test("legacy parent slug linked via top-level startSpan", () => {
    makeLogger();
    const pSpan = uuidv4();
    const pRoot = uuidv4();
    const legacySlug = new SpanComponentsV3({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "legacy-proj",
      row_id: uuidv4(),
      span_id: pSpan,
      root_span_id: pRoot,
    }).toStr();

    const child = startSpan({ name: "child", parent: legacySlug });
    expect(child.rootSpanId).toBe(pRoot);
    expect(child.spanParents).toEqual([pSpan]);
    expect(child.spanId.length).toBe(16);
    child.end();
  });
});

// --------------------------------------------------------------------------- //
// tracestate / trace-flags pass-through
// --------------------------------------------------------------------------- //

const UPSTREAM_TRACESTATE = "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7";

describe("tracestate / flags pass-through", () => {
  beforeEach(() => {
    _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.resetIdGenStateForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
  });

  function makeLogger() {
    return initLogger({ projectName: PROJECT_NAME });
  }

  test("extract then inject forwards tracestate", () => {
    const logger = makeLogger();
    const parent = extractTraceContextFromHeaders({
      traceparent: VALID_TRACEPARENT,
      baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
      tracestate: UPSTREAM_TRACESTATE,
    });
    const span = logger.startSpan({ name: "mid", parent });
    const outbound = span.inject({});
    span.end();
    expect(outbound[TRACESTATE_HEADER]).toBe(UPSTREAM_TRACESTATE);
    expect(outbound[TRACEPARENT_HEADER]).toMatch(TRACEPARENT_RE);
  });

  test("no tracestate emitted when none inbound", () => {
    const logger = makeLogger();
    const span = logger.startSpan({ name: "root" });
    const outbound = span.inject({});
    span.end();
    expect(TRACESTATE_HEADER in outbound).toBe(false);
  });

  test("inject leaves existing tracestate untouched when none inbound", () => {
    const logger = makeLogger();
    const span = logger.startSpan({ name: "root" });
    const outbound = span.inject({ [TRACESTATE_HEADER]: UPSTREAM_TRACESTATE });
    span.end();
    expect(outbound[TRACESTATE_HEADER]).toBe(UPSTREAM_TRACESTATE);
  });

  test.each([
    "ConGo=t61rcWkgMzE", // uppercase key
    "congo=", // empty value
    "congo=bad=value", // value cannot contain equals
    "congo=\u00e9", // non-ASCII value
    Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(","), // too many members
    `congo=${"a".repeat(513)}`, // too long overall
  ])("invalid tracestate is not forwarded: %s", (tracestate) => {
    // `tracestate` we forward but never author, so an inbound value that does
    // not conform to the W3C grammar/limits is dropped on extract rather than
    // relayed onward.
    const logger = makeLogger();
    const parent = extractTraceContextFromHeaders({
      traceparent: VALID_TRACEPARENT,
      baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
      tracestate,
    });
    const span = logger.startSpan({ name: "mid", parent });
    const outbound = span.inject({});
    span.end();
    expect(TRACESTATE_HEADER in outbound).toBe(false);
  });

  test("extract then inject preserves unsampled flag", () => {
    const logger = makeLogger();
    const unsampled = `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-00`;
    const parent = extractTraceContextFromHeaders({
      traceparent: unsampled,
      baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
    });
    const span = logger.startSpan({ name: "mid", parent });
    const outbound = span.inject({});
    span.end();
    expect(outbound[TRACEPARENT_HEADER].endsWith("-00")).toBe(true);
  });

  test("extract then inject preserves sampled flag", () => {
    const logger = makeLogger();
    const parent = extractTraceContextFromHeaders({
      traceparent: VALID_TRACEPARENT, // ...-01
      baggage: `${BRAINTRUST_PARENT_KEY}=project_id:abc`,
    });
    const span = logger.startSpan({ name: "mid", parent });
    const outbound = span.inject({});
    span.end();
    expect(outbound[TRACEPARENT_HEADER].endsWith("-01")).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// Legacy UUID mode
// --------------------------------------------------------------------------- //

describe("legacy UUID mode", () => {
  let prevLegacy: string | undefined;
  let prevOtel: string | undefined;

  beforeEach(() => {
    prevLegacy = process.env.BRAINTRUST_LEGACY_IDS;
    prevOtel = process.env.BRAINTRUST_OTEL_COMPAT;
    delete process.env.BRAINTRUST_OTEL_COMPAT;
    process.env.BRAINTRUST_LEGACY_IDS = "true";
    _exportsForTestingOnly.simulateLoginForTests();
    _exportsForTestingOnly.resetIdGenStateForTests();
    _exportsForTestingOnly.useTestBackgroundLogger();
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    _exportsForTestingOnly.simulateLogoutForTests();
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
    _exportsForTestingOnly.resetIdGenStateForTests();
  });

  test("inject no-ops in legacy UUID mode", () => {
    const logger = initLogger({ projectName: "legacy-inject" });
    const span = logger.startSpan({ name: "p" });
    // Legacy spans use UUID ids (share root == span).
    expect(span.spanId.length).toBe(36);
    const carrier = span.inject({ existing: "header" });
    span.end();

    expect(carrier).toEqual({ existing: "header" });
    expect(TRACEPARENT_HEADER in carrier).toBe(false);
    expect(BAGGAGE_HEADER in carrier).toBe(false);
  });

  test("legacy parent slug (UUID) linked in legacy mode", () => {
    const logger = initLogger({ projectName: "legacy-proj" });
    const pSpan = uuidv4();
    const pRoot = uuidv4();
    const legacySlug = new SpanComponentsV3({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "legacy-proj",
      row_id: uuidv4(),
      span_id: pSpan,
      root_span_id: pRoot,
    }).toStr();

    const child = logger.startSpan({ name: "child", parent: legacySlug });
    expect(child.rootSpanId).toBe(pRoot);
    expect(child.spanParents).toEqual([pSpan]);
    child.end();
  });

  test("hex parent slug linked in legacy mode", () => {
    const logger = initLogger({ projectName: "legacy-proj" });
    const pSpan = "00f067aa0ba902b7"; // 8-byte hex
    const pRoot = "4bf92f3577b34da6a3ce929d0e0e4736"; // 16-byte hex
    const hexSlug = new SpanComponentsV4({
      object_type: SpanObjectTypeV3.PROJECT_LOGS,
      object_id: "legacy-proj",
      row_id: "bt-row",
      span_id: pSpan,
      root_span_id: pRoot,
    }).toStr();

    const child = logger.startSpan({ name: "child", parent: hexSlug });
    // Links to the slug's hex ids; the child's own span id stays UUID.
    expect(child.rootSpanId).toBe(pRoot);
    expect(child.spanParents).toEqual([pSpan]);
    expect(child.spanId.length).toBe(36);
    child.end();
  });
});
