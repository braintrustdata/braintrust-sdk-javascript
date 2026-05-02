import { describe, expect, it } from "vitest";
import type {
  CassetteEntry,
  RecordedRequest,
  RecordedResponse,
} from "../src/cassette";
import {
  REDACTED_SENTINEL,
  applyRequestRedaction,
  applyResponseRedaction,
  checkStrictRedaction,
  resolveRedactors,
} from "../src/redactor";
import { apiKeyHeader, bearerToken, cookies } from "../src/redactor/presets";
import { CassetteRedactionError } from "../src/errors";

const baseReq: RecordedRequest = {
  method: "POST",
  url: "https://api.example.com/v1/chat?api_key=secret&prompt=hi",
  headers: {
    "content-type": "application/json",
    Authorization: "Bearer sk-abc123",
    "X-Api-Key": "secret",
  },
  body: {
    kind: "json",
    value: {
      model: "gpt-4",
      user: { email: "alice@example.com", name: "Alice" },
      apiKey: "sk-xxx",
    },
  },
};

const baseRes: RecordedResponse = {
  status: 200,
  headers: {
    "content-type": "application/json",
    "set-cookie": "session=abcdef",
  },
  body: {
    kind: "json",
    value: { id: "chatcmpl-1", user: { token: "bearer-xyz" } },
  },
};

describe("applyRequestRedaction", () => {
  it("returns the request unchanged when no spec is given", () => {
    expect(applyRequestRedaction(baseReq, undefined)).toEqual(baseReq);
  });

  it("returns the request unchanged when spec is false", () => {
    expect(applyRequestRedaction(baseReq, false)).toEqual(baseReq);
  });

  it("does not mutate the input", () => {
    const before = structuredClone(baseReq);
    applyRequestRedaction(baseReq, "aggressive");
    expect(baseReq).toEqual(before);
  });

  describe("redactHeaders", () => {
    it("masks matching headers with the sentinel value", () => {
      const out = applyRequestRedaction(baseReq, {
        redactHeaders: ["authorization"],
      });
      expect(out.headers.Authorization).toBe(REDACTED_SENTINEL);
      expect(out.headers["content-type"]).toBe("application/json");
    });

    it("matches header names case-insensitively", () => {
      const out = applyRequestRedaction(baseReq, {
        redactHeaders: ["AUTHORIZATION"],
      });
      expect(out.headers.Authorization).toBe(REDACTED_SENTINEL);
    });

    it("accepts RegExp patterns", () => {
      const out = applyRequestRedaction(baseReq, {
        redactHeaders: [/^x-api/i],
      });
      expect(out.headers["X-Api-Key"]).toBe(REDACTED_SENTINEL);
    });

    it("preserves the header so consumers can detect its presence", () => {
      const out = applyRequestRedaction(baseReq, {
        redactHeaders: ["authorization"],
      });
      expect(out.headers).toHaveProperty("Authorization");
    });
  });

  describe("redactBodyFields", () => {
    it("masks top-level fields", () => {
      const out = applyRequestRedaction(baseReq, {
        redactBodyFields: ["apiKey"],
      });
      const value = (out.body as { value: Record<string, unknown> }).value;
      expect(value.apiKey).toBe(REDACTED_SENTINEL);
      expect(value.model).toBe("gpt-4");
    });

    it("masks nested fields by dot-path", () => {
      const out = applyRequestRedaction(baseReq, {
        redactBodyFields: ["user.email"],
      });
      const value = (out.body as { value: { user: Record<string, unknown> } })
        .value;
      expect(value.user.email).toBe(REDACTED_SENTINEL);
      expect(value.user.name).toBe("Alice");
    });

    it("is a no-op for non-JSON text bodies", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: { kind: "text", value: "hi" },
      };
      const out = applyRequestRedaction(req, { redactBodyFields: ["apiKey"] });
      expect(out.body).toEqual({ kind: "text", value: "hi" });
    });

    it("masks fields in a text body that contains JSON (non-canonical content-type)", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: {
          kind: "text",
          value: JSON.stringify({ apiKey: "sk-secret", model: "gpt-4" }),
        },
      };
      const out = applyRequestRedaction(req, { redactBodyFields: ["apiKey"] });
      expect(out.body.kind).toBe("text");
      const parsed = JSON.parse(
        (out.body as { kind: "text"; value: string }).value,
      );
      expect(parsed.apiKey).toBe(REDACTED_SENTINEL);
      expect(parsed.model).toBe("gpt-4");
    });

    it("masks fields inside SSE data: lines that contain JSON", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: {
          kind: "sse",
          chunks: [
            'data: {"token": "sk-secret", "index": 0}',
            'data: {"token": "sk-secret2", "index": 1}',
          ],
        },
      };
      const out = applyRequestRedaction(req, { redactBodyFields: ["token"] });
      expect(out.body.kind).toBe("sse");
      const chunks = (out.body as { kind: "sse"; chunks: string[] }).chunks;
      expect(chunks[0]).toBe(
        `data: {"token":"${REDACTED_SENTINEL}","index":0}`,
      );
      expect(chunks[1]).toBe(
        `data: {"token":"${REDACTED_SENTINEL}","index":1}`,
      );
    });

    it("leaves non-JSON SSE lines untouched when masking body fields", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: {
          kind: "sse",
          chunks: ["event: done\ndata: [DONE]", 'data: {"result": "ok"}'],
        },
      };
      const out = applyRequestRedaction(req, { redactBodyFields: ["result"] });
      const chunks = (out.body as { kind: "sse"; chunks: string[] }).chunks;
      expect(chunks[0]).toBe("event: done\ndata: [DONE]");
      expect(chunks[1]).toBe(`data: {"result":"${REDACTED_SENTINEL}"}`);
    });
  });

  describe("redactBodyText", () => {
    it("applies a regex to a text body", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: {
          kind: "text",
          value: "Authorization: Bearer sk-abc123 is the token",
        },
      };
      const out = applyRequestRedaction(req, {
        redactBodyText: [/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g],
      });
      expect((out.body as { kind: "text"; value: string }).value).toBe(
        `Authorization: ${REDACTED_SENTINEL} is the token`,
      );
    });

    it("accepts a custom replacement string", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: { kind: "text", value: "key=abc123" },
      };
      const out = applyRequestRedaction(req, {
        redactBodyText: [
          { pattern: /key=[A-Za-z0-9]+/g, replacement: "key=HIDDEN" },
        ],
      });
      expect((out.body as { kind: "text"; value: string }).value).toBe(
        "key=HIDDEN",
      );
    });

    it("applies a regex to SSE chunks", () => {
      const req: RecordedRequest = {
        ...baseReq,
        body: {
          kind: "sse",
          chunks: [
            'data: {"msg": "token is Bearer sk-abc123"}',
            'data: {"msg": "hello"}',
          ],
        },
      };
      const out = applyRequestRedaction(req, {
        redactBodyText: [/Bearer\s+[A-Za-z0-9\-_.]+/g],
      });
      const chunks = (out.body as { kind: "sse"; chunks: string[] }).chunks;
      expect(chunks[0]).toContain(REDACTED_SENTINEL);
      expect(chunks[0]).not.toContain("sk-abc123");
      expect(chunks[1]).toBe('data: {"msg": "hello"}');
    });

    it("is a no-op for non-text bodies", () => {
      const out = applyRequestRedaction(baseReq, {
        redactBodyText: [/anything/g],
      });
      expect(out.body).toEqual(baseReq.body);
    });
  });

  describe("redactQueryParams", () => {
    it("removes matching query params from the URL", () => {
      const out = applyRequestRedaction(baseReq, {
        redactQueryParams: ["api_key"],
      });
      expect(out.url).not.toContain("api_key=");
      expect(out.url).toContain("prompt=hi");
    });
  });

  describe("redactRequest escape hatch", () => {
    it("runs after declarative redaction", () => {
      const out = applyRequestRedaction(baseReq, {
        redactHeaders: ["authorization"],
        redactRequest: (r) => {
          // Authorization should already be masked when this runs.
          expect(r.headers.Authorization).toBe(REDACTED_SENTINEL);
          return { ...r, method: "PUT" };
        },
      });
      expect(out.method).toBe("PUT");
    });
  });

  describe("'aggressive' preset", () => {
    it("masks credential headers", () => {
      const out = applyRequestRedaction(baseReq, "aggressive");
      expect(out.headers.Authorization).toBe(REDACTED_SENTINEL);
      expect(out.headers["X-Api-Key"]).toBe(REDACTED_SENTINEL);
      expect(out.headers["content-type"]).toBe("application/json");
    });

    it("does not touch body fields", () => {
      const out = applyRequestRedaction(baseReq, "aggressive");
      const value = (out.body as { value: Record<string, unknown> }).value;
      expect(value.apiKey).toBe("sk-xxx");
    });
  });

  describe("composition", () => {
    it("combines a preset with a custom config in array form", () => {
      const out = applyRequestRedaction(baseReq, [
        "aggressive",
        { redactBodyFields: ["user.email"] },
      ]);
      expect(out.headers.Authorization).toBe(REDACTED_SENTINEL);
      const value = (out.body as { value: { user: { email: string } } }).value;
      expect(value.user.email).toBe(REDACTED_SENTINEL);
    });
  });
});

describe("applyResponseRedaction", () => {
  it("masks response headers", () => {
    const out = applyResponseRedaction(baseRes, {
      redactHeaders: ["set-cookie"],
    });
    expect(out.headers["set-cookie"]).toBe(REDACTED_SENTINEL);
  });

  it("masks response body fields", () => {
    const out = applyResponseRedaction(baseRes, {
      redactBodyFields: ["user.token"],
    });
    const value = (out.body as { value: { user: { token: string } } }).value;
    expect(value.user.token).toBe(REDACTED_SENTINEL);
  });

  it("'aggressive' preset masks set-cookie on responses", () => {
    const out = applyResponseRedaction(baseRes, "aggressive");
    expect(out.headers["set-cookie"]).toBe(REDACTED_SENTINEL);
  });

  it("runs the redactResponse escape hatch", () => {
    const out = applyResponseRedaction(baseRes, {
      redactResponse: (r) => ({ ...r, status: 418 }),
    });
    expect(out.status).toBe(418);
  });
});

describe("redactor preset helpers", () => {
  it("bearerToken() masks Authorization", () => {
    const out = applyRequestRedaction(baseReq, bearerToken());
    expect(out.headers.Authorization).toBe(REDACTED_SENTINEL);
  });

  it("apiKeyHeader() masks both x-api-key and api-key", () => {
    const out = applyRequestRedaction(baseReq, apiKeyHeader());
    expect(out.headers["X-Api-Key"]).toBe(REDACTED_SENTINEL);
  });

  it("cookies() masks set-cookie on responses", () => {
    const out = applyResponseRedaction(baseRes, cookies());
    expect(out.headers["set-cookie"]).toBe(REDACTED_SENTINEL);
  });
});

describe("resolveRedactors", () => {
  it("returns empty array for undefined", () => {
    expect(resolveRedactors(undefined)).toEqual([]);
  });

  it("returns empty array for false", () => {
    expect(resolveRedactors(false)).toEqual([]);
  });

  it("returns single-element array for a preset name", () => {
    expect(resolveRedactors("aggressive")).toHaveLength(1);
  });

  it("flattens an array of presets and configs", () => {
    const result = resolveRedactors(["aggressive", { redactHeaders: ["x"] }]);
    expect(result).toHaveLength(2);
  });

  it("resolves the paranoid preset", () => {
    expect(resolveRedactors("paranoid")).toHaveLength(1);
  });
});

describe("'paranoid' preset", () => {
  it("masks credential headers", () => {
    const out = applyRequestRedaction(baseReq, "paranoid");
    expect(out.headers.Authorization).toBe(REDACTED_SENTINEL);
  });

  it("masks common credential field names in JSON bodies", () => {
    const req: RecordedRequest = {
      ...baseReq,
      body: { kind: "json", value: { apiKey: "sk-xxx", message: "hi" } },
    };
    const out = applyRequestRedaction(req, "paranoid");
    const value = (out.body as { value: Record<string, unknown> }).value;
    expect(value.apiKey).toBe(REDACTED_SENTINEL);
    expect(value.message).toBe("hi");
  });

  it("masks Bearer tokens in text bodies", () => {
    const req: RecordedRequest = {
      ...baseReq,
      body: { kind: "text", value: "The secret is Bearer sk-abc123rest" },
    };
    const out = applyRequestRedaction(req, "paranoid");
    expect((out.body as { kind: "text"; value: string }).value).not.toContain(
      "Bearer sk-abc123",
    );
    expect((out.body as { kind: "text"; value: string }).value).toContain(
      REDACTED_SENTINEL,
    );
  });
});

describe("checkStrictRedaction", () => {
  function makeEntry(
    reqBody: CassetteEntry["request"]["body"],
    reqHeaders: Record<string, string> = {},
  ): CassetteEntry {
    return {
      id: "test-id",
      matchKey: "POST example.com/",
      callIndex: 0,
      recordedAt: new Date().toISOString(),
      request: {
        method: "POST",
        url: "https://example.com/",
        headers: reqHeaders,
        body: reqBody,
      },
      response: {
        status: 200,
        headers: {},
        body: { kind: "json", value: { ok: true } },
      },
    };
  }

  it("does not throw when all patterns matched", () => {
    const entries: CassetteEntry[] = [
      makeEntry({ kind: "json", value: { apiKey: REDACTED_SENTINEL } }),
    ];
    expect(() =>
      checkStrictRedaction("test", entries, [
        { strict: true, redactBodyFields: ["apiKey"] },
      ]),
    ).not.toThrow();
  });

  it("throws CassetteRedactionError when a bodyField pattern matched nothing", () => {
    const entries: CassetteEntry[] = [
      makeEntry({ kind: "json", value: { model: "gpt-4" } }),
    ];
    expect(() =>
      checkStrictRedaction("test", entries, [
        { strict: true, redactBodyFields: ["api_Key"] },
      ]),
    ).toThrow(CassetteRedactionError);
  });

  it("throws CassetteRedactionError when a header pattern matched nothing", () => {
    const entries: CassetteEntry[] = [
      makeEntry({ kind: "empty" }, { "content-type": "application/json" }),
    ];
    expect(() =>
      checkStrictRedaction("test", entries, [
        { strict: true, redactHeaders: ["authorization"] },
      ]),
    ).toThrow(CassetteRedactionError);
  });

  it("includes all unmatched pattern descriptions in the error", () => {
    const entries: CassetteEntry[] = [makeEntry({ kind: "empty" })];
    let error: CassetteRedactionError | null = null;
    try {
      checkStrictRedaction("test", entries, [
        { strict: true, redactBodyFields: ["apiKey", "token"] },
      ]);
    } catch (e) {
      error = e as CassetteRedactionError;
    }
    expect(error).toBeInstanceOf(CassetteRedactionError);
    expect(error!.unmatchedPatterns).toHaveLength(2);
  });

  it("skips configs that do not have strict: true", () => {
    const entries: CassetteEntry[] = [makeEntry({ kind: "empty" })];
    expect(() =>
      checkStrictRedaction("test", entries, [
        { strict: false, redactBodyFields: ["apiKey"] },
      ]),
    ).not.toThrow();
  });

  it("detects sentinel in a text body that was JSON-redacted", () => {
    const redactedJson = JSON.stringify({ apiKey: REDACTED_SENTINEL });
    const entries: CassetteEntry[] = [
      makeEntry({ kind: "text", value: redactedJson }),
    ];
    expect(() =>
      checkStrictRedaction("test", entries, [
        { strict: true, redactBodyFields: ["apiKey"] },
      ]),
    ).not.toThrow();
  });
});
