import { describe, expect, it } from "vitest";
import {
  decodeBody,
  encodeBody,
  encodeBinaryDraft,
  isJsonContentType,
  isTextContentType,
  joinSseChunks,
  sha256Hex,
  splitSseChunks,
} from "../src/serializer";
import { createMemoryStore } from "../src/store";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("isJsonContentType", () => {
  it("matches application/json", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });

  it("matches +json suffixes", () => {
    expect(isJsonContentType("application/vnd.api+json")).toBe(true);
    expect(isJsonContentType("application/ld+json; charset=utf-8")).toBe(true);
  });

  it("does not match text/json (rare/invalid)", () => {
    expect(isJsonContentType("text/json")).toBe(false);
  });

  it("does not match plain text", () => {
    expect(isJsonContentType("text/plain")).toBe(false);
  });
});

describe("isTextContentType", () => {
  it("matches text/* types", () => {
    expect(isTextContentType("text/plain")).toBe(true);
    expect(isTextContentType("text/html; charset=utf-8")).toBe(true);
    expect(isTextContentType("text/csv")).toBe(true);
  });

  it("matches XML and form-urlencoded", () => {
    expect(isTextContentType("application/xml")).toBe(true);
    expect(isTextContentType("application/atom+xml")).toBe(true);
    expect(isTextContentType("application/x-www-form-urlencoded")).toBe(true);
  });

  it("does not match binary types", () => {
    expect(isTextContentType("application/octet-stream")).toBe(false);
    expect(isTextContentType("image/png")).toBe(false);
  });
});

describe("splitSseChunks / joinSseChunks", () => {
  it("splits a multi-event stream", () => {
    expect(splitSseChunks("data: a\n\ndata: b\n\n")).toEqual([
      "data: a",
      "data: b",
    ]);
  });

  it("handles a stream without trailing blank line", () => {
    expect(splitSseChunks("data: a\n\ndata: b")).toEqual([
      "data: a",
      "data: b",
    ]);
  });

  it("preserves multi-line data within an event", () => {
    expect(
      splitSseChunks("data: line1\ndata: line2\n\ndata: solo\n\n"),
    ).toEqual(["data: line1\ndata: line2", "data: solo"]);
  });

  it("preserves event/id/retry fields", () => {
    const text = "event: ping\ndata: hi\nid: 1\nretry: 5000\n\ndata: bye\n\n";
    const chunks = splitSseChunks(text);
    expect(chunks[0]).toContain("event: ping");
    expect(chunks[0]).toContain("id: 1");
    expect(chunks[1]).toBe("data: bye");
  });

  it("normalizes CRLF to LF", () => {
    expect(splitSseChunks("data: a\r\n\r\ndata: b\r\n\r\n")).toEqual([
      "data: a",
      "data: b",
    ]);
  });

  it("round-trips chunks through join", () => {
    const original = "data: a\n\ndata: b\n\n";
    expect(joinSseChunks(splitSseChunks(original))).toBe(original);
  });
});

describe("sha256Hex", () => {
  it("returns a 64-char lowercase hex string", () => {
    const hash = sha256Hex(new Uint8Array([0xff, 0x00, 0xab]));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for the same bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes));
  });

  it("differs for different bytes", () => {
    expect(sha256Hex(new Uint8Array([1]))).not.toBe(
      sha256Hex(new Uint8Array([2])),
    );
  });
});

describe("encodeBody", () => {
  it("returns kind=empty for zero-length bytes", () => {
    expect(encodeBody(new Uint8Array(), "application/json")).toEqual({
      kind: "empty",
    });
  });

  it("returns kind=empty regardless of content-type", () => {
    expect(encodeBody(new Uint8Array(), undefined)).toEqual({ kind: "empty" });
  });

  it("parses JSON when content-type is application/json", () => {
    const result = encodeBody(text('{"hello":"world"}'), "application/json");
    expect(result).toEqual({ kind: "json", value: { hello: "world" } });
  });

  it("parses JSON for +json content types", () => {
    const result = encodeBody(text('{"a":1}'), "application/vnd.api+json");
    expect(result).toEqual({ kind: "json", value: { a: 1 } });
  });

  it("falls back to text when JSON parsing fails despite content-type", () => {
    const result = encodeBody(text("not json"), "application/json");
    expect(result).toEqual({ kind: "text", value: "not json" });
  });

  it("encodes text/event-stream as SSE chunks", () => {
    const result = encodeBody(
      text("data: a\n\ndata: b\n\n"),
      "text/event-stream",
    );
    expect(result).toEqual({ kind: "sse", chunks: ["data: a", "data: b"] });
  });

  it("encodes plain text", () => {
    const result = encodeBody(text("hello"), "text/plain");
    expect(result).toEqual({ kind: "text", value: "hello" });
  });

  it("encodes binary as base64 below threshold", () => {
    const bytes = new Uint8Array([0xff, 0x00, 0xab]);
    const result = encodeBody(bytes, "application/octet-stream");
    expect(result.kind).toBe("base64");
    if (result.kind === "base64") {
      expect(result.value).toBe("/wCr");
      expect(result.contentType).toBe("application/octet-stream");
    }
  });

  it("encodes as base64 when content-type is missing", () => {
    const bytes = new Uint8Array([0xff, 0x00, 0xab]);
    const result = encodeBody(bytes, undefined);
    expect(result.kind).toBe("base64");
  });

  it("encodes XML as text", () => {
    const result = encodeBody(text("<x/>"), "application/xml");
    expect(result).toEqual({ kind: "text", value: "<x/>" });
  });

  describe("threshold", () => {
    const bigBytes = new Uint8Array(100).fill(0xaa);

    it("returns base64 when bytes are below the threshold", () => {
      const result = encodeBody(bigBytes, "application/octet-stream", 200);
      expect(result.kind).toBe("base64");
    });

    it("returns binary when bytes meet the threshold", () => {
      const result = encodeBody(bigBytes, "application/octet-stream", 100);
      expect(result.kind).toBe("binary");
      if (result.kind === "binary") {
        expect(result.sha256).toHaveLength(64);
        expect(result.path).toBe("");
        expect(result.contentType).toBe("application/octet-stream");
      }
    });

    it("returns binary when bytes exceed the threshold", () => {
      const result = encodeBody(bigBytes, "application/octet-stream", 50);
      expect(result.kind).toBe("binary");
    });

    it("does not apply threshold to JSON bodies", () => {
      const jsonBytes = text('{"x":1}');
      const result = encodeBody(jsonBytes, "application/json", 1);
      expect(result.kind).toBe("json");
    });

    it("false disables threshold (always base64)", () => {
      const result = encodeBody(bigBytes, "application/octet-stream", false);
      expect(result.kind).toBe("base64");
    });

    it("omitting threshold defaults to base64", () => {
      const result = encodeBody(bigBytes, "application/octet-stream");
      expect(result.kind).toBe("base64");
    });
  });
});

describe("encodeBinaryDraft", () => {
  it("returns a binary-draft with sha256 and bytes", () => {
    const bytes = new Uint8Array([0xff, 0x00]);
    const draft = encodeBinaryDraft(bytes, "image/png");
    expect(draft.kind).toBe("binary-draft");
    expect(draft.bytes).toBe(bytes);
    expect(draft.sha256).toHaveLength(64);
    expect(draft.contentType).toBe("image/png");
  });

  it("omits contentType when not provided", () => {
    const draft = encodeBinaryDraft(new Uint8Array([1]), undefined);
    expect(draft.contentType).toBeUndefined();
  });

  it("sha256 matches what sha256Hex produces", () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const draft = encodeBinaryDraft(bytes, undefined);
    expect(draft.sha256).toBe(sha256Hex(bytes));
  });
});

describe("decodeBody", () => {
  it("decodes empty to zero bytes", async () => {
    expect(await decodeBody({ kind: "empty" })).toEqual(new Uint8Array());
  });

  it("decodes JSON via JSON.stringify (compact)", async () => {
    const out = await decodeBody({ kind: "json", value: { a: 1, b: [2, 3] } });
    expect(decode(out)).toBe('{"a":1,"b":[2,3]}');
  });

  it("decodes text", async () => {
    expect(decode(await decodeBody({ kind: "text", value: "hello" }))).toBe(
      "hello",
    );
  });

  it("decodes SSE chunks back into a stream", async () => {
    const out = await decodeBody({
      kind: "sse",
      chunks: ["data: a", "data: b"],
    });
    expect(decode(out)).toBe("data: a\n\ndata: b\n\n");
  });

  it("decodes base64 to original bytes", async () => {
    const out = await decodeBody({ kind: "base64", value: "/wCr" });
    expect(out).toEqual(new Uint8Array([0xff, 0x00, 0xab]));
  });

  it("decodes a binary body via the store", async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const store = createMemoryStore();
    const path = await store.saveBlob!("test", bytes);
    const out = await decodeBody(
      { kind: "binary", path, sha256: sha256Hex(bytes) },
      { store, name: "test" },
    );
    expect(out).toEqual(bytes);
  });

  it("throws when decoding a binary body without a store", async () => {
    await expect(
      decodeBody({
        kind: "binary",
        path: "blobs/abc.bin",
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("loadBlob");
  });

  it("round-trips text bodies byte-exactly", async () => {
    const original = text("hello world");
    const encoded = encodeBody(original, "text/plain");
    const decoded = await decodeBody(encoded);
    expect(decoded).toEqual(original);
  });

  it("round-trips binary bodies byte-exactly via store", async () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const store = createMemoryStore();
    const path = await store.saveBlob!("t", original);
    const body = { kind: "binary" as const, path, sha256: sha256Hex(original) };
    const decoded = await decodeBody(body, { store, name: "t" });
    expect(decoded).toEqual(original);
  });

  it("round-trips SSE bodies", async () => {
    const original = text("data: hello\n\ndata: world\n\n");
    const encoded = encodeBody(original, "text/event-stream");
    const decoded = await decodeBody(encoded);
    expect(decoded).toEqual(original);
  });

  it("round-trips JSON bodies for parse-equivalent content", async () => {
    const encoded = encodeBody(text('{"a":1,"b":2}'), "application/json");
    const decoded = await decodeBody(encoded);
    // Bytes match (order of keys preserved by V8 for non-numeric keys)
    expect(decode(decoded)).toBe('{"a":1,"b":2}');
  });
});
