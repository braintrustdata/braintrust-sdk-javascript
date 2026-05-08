import { describe, expect, it } from "vitest";
import type { BodyPayload, Cassette } from "../src/cassette";
import { CURRENT_FORMAT_VERSION, cassetteSchema } from "../src/format/v1";

const minimalValidCassette: Cassette = {
  version: 1,
  entries: [],
};

const validCassetteWithEntry: Cassette = {
  version: 1,
  meta: {
    createdAt: "2026-04-29T12:00:00.000Z",
    seinfeldVersion: "0.1.0",
  },
  entries: [
    {
      id: "abc123",
      matchKey: "POST api.openai.com/v1/chat/completions",
      callIndex: 0,
      recordedAt: "2026-04-29T12:00:00.000Z",
      request: {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        headers: { "content-type": "application/json" },
        body: { kind: "json", value: { model: "gpt-4" } },
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { kind: "json", value: { id: "chatcmpl-1" } },
      },
    },
  ],
};

describe("cassette schema (v1)", () => {
  it("exposes the current format version as 1", () => {
    expect(CURRENT_FORMAT_VERSION).toBe(1);
  });

  it("accepts a minimal valid cassette", () => {
    const result = cassetteSchema.safeParse(minimalValidCassette);
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated cassette with one entry", () => {
    const result = cassetteSchema.safeParse(validCassetteWithEntry);
    expect(result.success).toBe(true);
  });

  it("rejects a cassette with a wrong version literal", () => {
    const result = cassetteSchema.safeParse({
      ...minimalValidCassette,
      version: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a cassette with no version field", () => {
    const result = cassetteSchema.safeParse({ entries: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a cassette with an invalid status code", () => {
    const cassette = structuredClone(validCassetteWithEntry);
    cassette.entries[0]!.response.status = 99;
    const result = cassetteSchema.safeParse(cassette);
    expect(result.success).toBe(false);
  });

  it("rejects a cassette with a negative call index", () => {
    const cassette = structuredClone(validCassetteWithEntry);
    cassette.entries[0]!.callIndex = -1;
    const result = cassetteSchema.safeParse(cassette);
    expect(result.success).toBe(false);
  });

  it("accepts all six body payload kinds", () => {
    const bodies: BodyPayload[] = [
      { kind: "empty" },
      { kind: "json", value: { hello: "world" } },
      { kind: "text", value: "plain text" },
      {
        kind: "base64",
        value: "aGVsbG8=",
        contentType: "application/octet-stream",
      },
      { kind: "sse", chunks: ["data: one", "data: two"] },
      {
        kind: "binary",
        path: "foo.cassette.blobs/abc123.bin",
        contentType: "application/octet-stream",
        sha256: "a".repeat(64),
      },
    ];
    const cassette: Cassette = {
      version: 1,
      entries: bodies.map((body, i) => ({
        id: `entry-${i}`,
        matchKey: "GET example.com/",
        callIndex: i,
        recordedAt: "2026-04-29T12:00:00.000Z",
        request: {
          method: "GET",
          url: "https://example.com/",
          headers: {},
          body: { kind: "empty" },
        },
        response: {
          status: 200,
          headers: {},
          body,
        },
      })),
    };
    const result = cassetteSchema.safeParse(cassette);
    expect(result.success).toBe(true);
  });

  it("rejects binary body with empty path", () => {
    const cassette = structuredClone(validCassetteWithEntry);
    (cassette.entries[0]!.response.body as unknown) = {
      kind: "binary",
      path: "",
      sha256: "a".repeat(64),
    };
    const result = cassetteSchema.safeParse(cassette);
    expect(result.success).toBe(false);
  });

  it("rejects binary body with wrong sha256 length", () => {
    const cassette = structuredClone(validCassetteWithEntry);
    (cassette.entries[0]!.response.body as unknown) = {
      kind: "binary",
      path: "foo.blobs/abc.bin",
      sha256: "tooshort",
    };
    const result = cassetteSchema.safeParse(cassette);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown body payload kind", () => {
    const cassette = structuredClone(validCassetteWithEntry);
    (cassette.entries[0]!.response.body as unknown) = {
      kind: "wat",
      value: "nope",
    };
    const result = cassetteSchema.safeParse(cassette);
    expect(result.success).toBe(false);
  });

  it("preserves unknown meta fields via passthrough", () => {
    const cassette = {
      version: 1,
      meta: {
        createdAt: "2026-04-29T12:00:00.000Z",
        seinfeldVersion: "0.1.0",
        customField: "arbitrary-value",
      },
      entries: [],
    };
    const result = cassetteSchema.safeParse(cassette);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta).toMatchObject({
        customField: "arbitrary-value",
      });
    }
  });
});
