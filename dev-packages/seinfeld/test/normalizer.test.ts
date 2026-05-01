import { describe, expect, it } from "vitest";
import type { RecordedRequest } from "../src/cassette";
import { applyFilters, resolveFilters } from "../src/normalizer";

const baseReq: RecordedRequest = {
  method: "POST",
  url: "https://api.example.com/v1/chat?api_key=secret&prompt=hi",
  headers: {
    "content-type": "application/json",
    Authorization: "Bearer sk-abc123",
    "X-Api-Key": "secret",
    "User-Agent": "node-fetch/3.0",
    "x-ratelimit-remaining": "99",
  },
  body: {
    kind: "json",
    value: {
      model: "gpt-4",
      messages: [
        { role: "user", content: "hi", id: "msg-001" },
        { role: "assistant", content: "hello", id: "msg-002" },
      ],
      metadata: {
        requestId: "req-xyz",
        timestamp: "2026-04-29T12:00:00Z",
      },
    },
  },
};

describe("applyFilters", () => {
  it("returns the request unchanged when no spec is given", () => {
    expect(applyFilters(baseReq, undefined)).toEqual(baseReq);
  });

  it("returns the request unchanged for the 'none' preset", () => {
    expect(applyFilters(baseReq, "none")).toEqual(baseReq);
  });

  it("does not mutate the input request", () => {
    const before = structuredClone(baseReq);
    applyFilters(baseReq, { ignoreHeaders: ["Authorization"] });
    expect(baseReq).toEqual(before);
  });

  describe("ignoreHeaders", () => {
    it("drops matching headers (case-insensitive string)", () => {
      const out = applyFilters(baseReq, { ignoreHeaders: ["authorization"] });
      expect(out.headers).not.toHaveProperty("Authorization");
      expect(out.headers).toHaveProperty("content-type");
    });

    it("drops headers matching a RegExp", () => {
      const out = applyFilters(baseReq, { ignoreHeaders: [/^x-/i] });
      expect(out.headers).not.toHaveProperty("X-Api-Key");
      expect(out.headers).not.toHaveProperty("x-ratelimit-remaining");
      expect(out.headers).toHaveProperty("Authorization");
    });

    it("preserves the values of non-matching headers", () => {
      const out = applyFilters(baseReq, { ignoreHeaders: ["authorization"] });
      expect(out.headers["content-type"]).toBe("application/json");
    });
  });

  describe("ignoreQueryParams", () => {
    it("strips matching query parameters", () => {
      const out = applyFilters(baseReq, { ignoreQueryParams: ["api_key"] });
      expect(out.url).not.toContain("api_key=");
      expect(out.url).toContain("prompt=hi");
    });

    it("handles RegExp patterns", () => {
      const out = applyFilters(baseReq, { ignoreQueryParams: [/^api_/] });
      expect(out.url).not.toContain("api_key=");
    });

    it("produces a clean URL when all params are stripped", () => {
      const req: RecordedRequest = {
        ...baseReq,
        url: "https://api.example.com/v1/chat?api_key=secret",
      };
      const out = applyFilters(req, { ignoreQueryParams: ["api_key"] });
      expect(out.url).toBe("https://api.example.com/v1/chat");
    });
  });

  describe("ignoreBodyFields", () => {
    it("strips top-level fields by exact path", () => {
      const out = applyFilters(baseReq, { ignoreBodyFields: ["model"] });
      expect(
        (out.body as { value: { model?: string } }).value,
      ).not.toHaveProperty("model");
    });

    it("strips nested fields by dot-path", () => {
      const out = applyFilters(baseReq, {
        ignoreBodyFields: ["metadata.requestId"],
      });
      const value = (
        out.body as { value: { metadata: Record<string, unknown> } }
      ).value;
      expect(value.metadata).not.toHaveProperty("requestId");
      expect(value.metadata).toHaveProperty("timestamp");
    });

    it("strips fields matching a RegExp on the dot-path", () => {
      const out = applyFilters(baseReq, {
        ignoreBodyFields: [/^messages\.\d+\.id$/],
      });
      const value = (
        out.body as {
          value: { messages: Array<{ id?: string; content?: string }> };
        }
      ).value;
      expect(value.messages[0]).not.toHaveProperty("id");
      expect(value.messages[1]).not.toHaveProperty("id");
      expect(value.messages[0]).toHaveProperty("content");
    });

    it("is a no-op for non-JSON bodies", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: { kind: "text", value: "hello" },
      };
      const out = applyFilters(req, { ignoreBodyFields: ["model"] });
      expect(out.body).toEqual({ kind: "text", value: "hello" });
    });

    it("handles arrays by walking elements with numeric indices", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: {
          kind: "json",
          value: { items: [{ id: "a" }, { id: "b" }] },
        },
      };
      const out = applyFilters(req, { ignoreBodyFields: ["items.0.id"] });
      const value = (out.body as { value: { items: Array<{ id?: string }> } })
        .value;
      expect(value.items[0]).not.toHaveProperty("id");
      expect(value.items[1]).toHaveProperty("id");
    });

    it("strips fields matching a * wildcard (single-segment)", () => {
      const out = applyFilters(baseReq, {
        ignoreBodyFields: ["messages.*.id"],
      });
      const value = (
        out.body as {
          value: { messages: Array<{ id?: string; content?: string }> };
        }
      ).value;
      expect(value.messages[0]).not.toHaveProperty("id");
      expect(value.messages[1]).not.toHaveProperty("id");
      expect(value.messages[0]).toHaveProperty("content");
    });

    it("strips fields matching a ** wildcard (multi-segment)", () => {
      const out = applyFilters(baseReq, {
        ignoreBodyFields: ["metadata.**.requestId"],
      });
      // metadata.requestId — ** matches zero segments
      const value = (
        out.body as { value: { metadata: Record<string, unknown> } }
      ).value;
      expect(value.metadata).not.toHaveProperty("requestId");
      expect(value.metadata).toHaveProperty("timestamp");
    });
  });

  describe("normalizeRequest escape hatch", () => {
    it("runs after declarative filters within a single config", () => {
      const out = applyFilters(baseReq, {
        ignoreHeaders: ["authorization"],
        normalizeRequest: (r) => {
          // After ignoreHeaders runs, Authorization should already be gone.
          expect(r.headers).not.toHaveProperty("Authorization");
          return { ...r, method: "PUT" };
        },
      });
      expect(out.method).toBe("PUT");
    });
  });

  describe("composition", () => {
    it("runs configs in array order", () => {
      const out = applyFilters(baseReq, [
        { ignoreHeaders: ["authorization"] },
        { ignoreHeaders: ["x-api-key"] },
      ]);
      expect(out.headers).not.toHaveProperty("Authorization");
      expect(out.headers).not.toHaveProperty("X-Api-Key");
    });

    it("mixes presets and configs", () => {
      const out = applyFilters(baseReq, [
        "minimal",
        { ignoreBodyFields: ["model"] },
      ]);
      expect(
        (out.body as { value: { model?: string } }).value,
      ).not.toHaveProperty("model");
    });
  });

  describe("built-in presets", () => {
    it("'default' strips auth + transport + rate-limit + user-agent", () => {
      const out = applyFilters(baseReq, "default");
      expect(out.headers).not.toHaveProperty("Authorization");
      expect(out.headers).not.toHaveProperty("X-Api-Key");
      expect(out.headers).not.toHaveProperty("User-Agent");
      expect(out.headers).not.toHaveProperty("x-ratelimit-remaining");
      expect(out.headers).toHaveProperty("content-type");
    });

    it("'minimal' only strips transport headers", () => {
      const reqWithTransport: RecordedRequest = {
        ...baseReq,
        headers: { ...baseReq.headers, "content-encoding": "gzip" },
      };
      const out = applyFilters(reqWithTransport, "minimal");
      expect(out.headers).not.toHaveProperty("content-encoding");
      expect(out.headers).toHaveProperty("Authorization");
    });
  });
});

describe("resolveFilters", () => {
  it("returns empty array for undefined", () => {
    expect(resolveFilters(undefined)).toEqual([]);
  });

  it("returns single-element array for a preset name", () => {
    expect(resolveFilters("default")).toHaveLength(1);
  });

  it("flattens an array of presets and configs", () => {
    const result = resolveFilters([
      "default",
      { ignoreHeaders: ["x"] },
      "minimal",
    ]);
    expect(result).toHaveLength(3);
  });
});
