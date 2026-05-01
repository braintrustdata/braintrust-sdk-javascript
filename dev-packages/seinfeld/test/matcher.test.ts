import { describe, expect, it } from "vitest";
import type { CassetteEntry, NormalizedRequest } from "../src/cassette";
import {
  asNormalized,
  computeMatchKey,
  createDefaultMatcher,
} from "../src/matcher";
import type { MatchCandidate } from "../src/matcher";

function makeRequest(
  overrides: Partial<NormalizedRequest> = {},
): NormalizedRequest {
  return asNormalized({
    method: "POST",
    url: "https://api.example.com/v1/chat",
    headers: {},
    body: { kind: "json", value: { model: "gpt-4" } },
    ...overrides,
  });
}

function makeEntry(
  overrides: Omit<Partial<CassetteEntry>, "request"> & {
    request?: Partial<NormalizedRequest>;
  } = {},
): CassetteEntry {
  const request = {
    method: "POST",
    url: "https://api.example.com/v1/chat",
    headers: {},
    body: { kind: "json" as const, value: { model: "gpt-4" } },
    ...overrides.request,
  };
  return {
    id: overrides.id ?? "e1",
    matchKey:
      overrides.matchKey ?? computeMatchKey(request.method, request.url),
    callIndex: overrides.callIndex ?? 0,
    recordedAt: overrides.recordedAt ?? "2026-04-29T12:00:00.000Z",
    request,
    response: overrides.response ?? {
      status: 200,
      headers: {},
      body: { kind: "json", value: { id: "chatcmpl-1" } },
    },
  };
}

function makeCandidate(entry: CassetteEntry): MatchCandidate {
  return { entry, filtered: asNormalized(entry.request) };
}

describe("computeMatchKey", () => {
  it("produces METHOD host/path without query", () => {
    expect(
      computeMatchKey("POST", "https://api.example.com/v1/chat?stream=true"),
    ).toBe("POST api.example.com/v1/chat");
  });

  it("uppercases the method", () => {
    expect(computeMatchKey("post", "https://example.com/x")).toBe(
      "POST example.com/x",
    );
  });

  it("preserves the path", () => {
    expect(
      computeMatchKey("GET", "https://api.example.com/v1/users/42/profile"),
    ).toBe("GET api.example.com/v1/users/42/profile");
  });
});

describe("asNormalized", () => {
  it("attaches a matchKey field", () => {
    const req = asNormalized({
      method: "GET",
      url: "https://example.com/foo",
      headers: {},
      body: { kind: "empty" as const },
    });
    expect(req.matchKey).toBe("GET example.com/foo");
  });
});

describe("createDefaultMatcher", () => {
  const matcher = createDefaultMatcher();

  it("returns null when there are no candidates", () => {
    expect(matcher.findMatch(makeRequest(), [], 0)).toBeNull();
  });

  it("matches on method + url + body", () => {
    const entry = makeEntry();
    const result = matcher.findMatch(makeRequest(), [makeCandidate(entry)], 0);
    expect(result).toBe(entry);
  });

  it("does not match when methods differ", () => {
    const entry = makeEntry({ request: { method: "GET" } });
    const result = matcher.findMatch(
      makeRequest({ method: "POST" }),
      [makeCandidate(entry)],
      0,
    );
    expect(result).toBeNull();
  });

  it("does not match when paths differ", () => {
    const entry = makeEntry({
      request: { url: "https://api.example.com/v1/chat/other" },
    });
    const result = matcher.findMatch(makeRequest(), [makeCandidate(entry)], 0);
    expect(result).toBeNull();
  });

  it("does not match when bodies differ", () => {
    const entry = makeEntry({
      request: { body: { kind: "json", value: { model: "gpt-3.5" } } },
    });
    const result = matcher.findMatch(makeRequest(), [makeCandidate(entry)], 0);
    expect(result).toBeNull();
  });

  it("ignores headers when matching", () => {
    const entry = makeEntry({ request: { headers: { "x-custom": "a" } } });
    const result = matcher.findMatch(
      makeRequest({ headers: { "x-custom": "b" } }),
      [makeCandidate(entry)],
      0,
    );
    expect(result).toBe(entry);
  });

  describe("per-key call counter", () => {
    const e1 = makeEntry({ id: "e1", callIndex: 0 });
    const e2 = makeEntry({
      id: "e2",
      callIndex: 1,
      response: {
        status: 201,
        headers: {},
        body: { kind: "json", value: { id: "second" } },
      },
    });
    const e3 = makeEntry({
      id: "e3",
      callIndex: 2,
      response: {
        status: 202,
        headers: {},
        body: { kind: "json", value: { id: "third" } },
      },
    });
    const candidates = [e1, e2, e3].map(makeCandidate);

    it("returns the first candidate at callIndex 0", () => {
      expect(matcher.findMatch(makeRequest(), candidates, 0)).toBe(e1);
    });

    it("returns the second candidate at callIndex 1", () => {
      expect(matcher.findMatch(makeRequest(), candidates, 1)).toBe(e2);
    });

    it("clamps to the last candidate when callIndex exceeds the count", () => {
      expect(matcher.findMatch(makeRequest(), candidates, 10)).toBe(e3);
    });

    it("with a single candidate, all calls return the same entry", () => {
      expect(matcher.findMatch(makeRequest(), [makeCandidate(e1)], 0)).toBe(e1);
      expect(matcher.findMatch(makeRequest(), [makeCandidate(e1)], 5)).toBe(e1);
    });
  });

  describe("body kinds", () => {
    it("matches text bodies by string equality", () => {
      const req = makeRequest({ body: { kind: "text", value: "hello" } });
      const entry = makeEntry({
        request: { body: { kind: "text", value: "hello" } },
      });
      expect(matcher.findMatch(req, [makeCandidate(entry)], 0)).toBe(entry);
    });

    it("matches empty bodies", () => {
      const req = makeRequest({ body: { kind: "empty" } });
      const entry = makeEntry({ request: { body: { kind: "empty" } } });
      expect(matcher.findMatch(req, [makeCandidate(entry)], 0)).toBe(entry);
    });

    it("does not match across body kinds", () => {
      const req = makeRequest({ body: { kind: "json", value: { x: 1 } } });
      const entry = makeEntry({
        request: { body: { kind: "text", value: '{"x":1}' } },
      });
      expect(matcher.findMatch(req, [makeCandidate(entry)], 0)).toBeNull();
    });

    it("matches binary bodies by sha256 digest", () => {
      const sha256 = "a".repeat(64);
      const req = makeRequest({ body: { kind: "binary", path: "", sha256 } });
      const entry = makeEntry({
        request: {
          body: { kind: "binary", path: "foo.blobs/abc.bin", sha256 },
        },
      });
      expect(matcher.findMatch(req, [makeCandidate(entry)], 0)).toBe(entry);
    });

    it("does not match binary bodies with different sha256", () => {
      const req = makeRequest({
        body: { kind: "binary", path: "", sha256: "a".repeat(64) },
      });
      const entry = makeEntry({
        request: {
          body: {
            kind: "binary",
            path: "foo.blobs/abc.bin",
            sha256: "b".repeat(64),
          },
        },
      });
      expect(matcher.findMatch(req, [makeCandidate(entry)], 0)).toBeNull();
    });

    it("does not match binary against base64 even if bytes happen to match", () => {
      const req = makeRequest({
        body: { kind: "binary", path: "", sha256: "a".repeat(64) },
      });
      const entry = makeEntry({
        request: { body: { kind: "base64", value: "abc=" } },
      });
      expect(matcher.findMatch(req, [makeCandidate(entry)], 0)).toBeNull();
    });

    it("matches JSON bodies regardless of key order", () => {
      const req = makeRequest({
        body: { kind: "json", value: { a: 1, b: 2 } },
      });
      const entry = makeEntry({
        request: { body: { kind: "json", value: { b: 2, a: 1 } } },
      });
      expect(matcher.findMatch(req, [makeCandidate(entry)], 0)).toBe(entry);
    });

    it("does not match JSON bodies with different nested values", () => {
      const req = makeRequest({
        body: { kind: "json", value: { messages: [{ id: "a" }] } },
      });
      const entry = makeEntry({
        request: { body: { kind: "json", value: { messages: [{ id: "b" }] } } },
      });
      expect(matcher.findMatch(req, [makeCandidate(entry)], 0)).toBeNull();
    });
  });
});
