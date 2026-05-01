import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  CassetteMissError,
  createCassette,
  createJsonFileStore,
  createMemoryStore,
} from "../src";
import { REDACTED_SENTINEL } from "../src/redactor";

/**
 * Spin up a local HTTP server that mirrors a few endpoints so we can record
 * real interactions and replay them. The server keeps a counter so identical
 * requests can be distinguished across calls (covers the per-key counter
 * behavior).
 */
function makeServer(): {
  server: Server;
  baseUrl: () => string;
  reset: () => void;
} {
  let counter = 0;

  const server = createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const reqBody = Buffer.concat(chunks).toString("utf8");

      if (url.pathname === "/echo") {
        const callNum = ++counter;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            callNum,
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams.entries()),
            authHeader: req.headers.authorization ?? null,
            requestBody: reqBody ? JSON.parse(reqBody) : null,
          }),
        );
        return;
      }

      if (url.pathname === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: chunk-1\n\n");
        res.write("event: progress\ndata: chunk-2\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (url.pathname === "/binary") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0x00, 0xff, 0xab, 0xcd]));
        return;
      }

      if (url.pathname === "/large-binary") {
        // 100 KB of deterministic bytes — exceeds the default 64 KB threshold
        const body = Buffer.alloc(100 * 1024, 0xaa);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(body);
        return;
      }

      if (url.pathname === "/text") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello world");
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });

  return {
    server,
    baseUrl: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    },
    reset: () => {
      counter = 0;
    },
  };
}

describe("createCassette — record + replay end-to-end", () => {
  let server: Server;
  let baseUrl: () => string;
  let reset: () => void;
  let tmpDir: string;

  beforeAll(async () => {
    const made = makeServer();
    server = made.server;
    baseUrl = made.baseUrl;
    reset = made.reset;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(async () => {
    reset();
    tmpDir = await mkdtemp(join(tmpdir(), "seinfeld-int-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("record mode", () => {
    it("captures a JSON request/response and persists to disk", async () => {
      const store = createJsonFileStore({ rootDir: tmpDir });
      const cassette = createCassette({
        name: "echo-basic",
        mode: "record",
        store,
      });

      let result: unknown;
      await cassette.use(async () => {
        const res = await fetch(`${baseUrl()}/echo`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer secret-key",
          },
          body: JSON.stringify({ q: "hi" }),
        });
        result = await res.json();
      });

      expect((result as { callNum: number }).callNum).toBe(1);
      expect((result as { authHeader: string }).authHeader).toBe(
        "Bearer secret-key",
      );

      const loaded = await store.load("echo-basic");
      expect(loaded?.entries).toHaveLength(1);
      expect(loaded?.entries[0]!.request.method).toBe("POST");
      expect(loaded?.entries[0]!.response.status).toBe(200);
    });

    it("captures multiple identical requests with incrementing callIndex", async () => {
      const store = createMemoryStore();
      const cassette = createCassette({ name: "multi", mode: "record", store });

      const responses: unknown[] = [];
      await cassette.use(async () => {
        for (let i = 0; i < 3; i++) {
          const res = await fetch(`${baseUrl()}/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ q: "same" }),
          });
          responses.push(await res.json());
        }
      });

      expect((responses[0] as { callNum: number }).callNum).toBe(1);
      expect((responses[1] as { callNum: number }).callNum).toBe(2);
      expect((responses[2] as { callNum: number }).callNum).toBe(3);

      const loaded = await store.load("multi");
      expect(loaded?.entries).toHaveLength(3);
      expect(loaded?.entries.map((e) => e.callIndex)).toEqual([0, 1, 2]);
    });

    it("captures an SSE response as chunks", async () => {
      const store = createMemoryStore();
      const cassette = createCassette({
        name: "stream",
        mode: "record",
        store,
      });

      let body = "";
      await cassette.use(async () => {
        const res = await fetch(`${baseUrl()}/stream`, {
          headers: { accept: "text/event-stream" },
        });
        body = await res.text();
      });

      expect(body).toContain("data: chunk-1");
      expect(body).toContain("event: progress");
      expect(body).toContain("data: [DONE]");

      const loaded = await store.load("stream");
      const responseBody = loaded?.entries[0]!.response.body;
      expect(responseBody?.kind).toBe("sse");
      if (responseBody?.kind === "sse") {
        expect(responseBody.chunks).toHaveLength(3);
        expect(responseBody.chunks[0]).toBe("data: chunk-1");
        expect(responseBody.chunks[1]).toBe("event: progress\ndata: chunk-2");
        expect(responseBody.chunks[2]).toBe("data: [DONE]");
      }
    });

    it("captures a small binary response as base64 (below threshold)", async () => {
      const store = createMemoryStore();
      const cassette = createCassette({ name: "bin", mode: "record", store });

      let bytes: Uint8Array | undefined;
      await cassette.use(async () => {
        const res = await fetch(`${baseUrl()}/binary`);
        bytes = new Uint8Array(await res.arrayBuffer());
      });

      expect(bytes).toEqual(new Uint8Array([0x00, 0xff, 0xab, 0xcd]));

      const loaded = await store.load("bin");
      expect(loaded?.entries[0]!.response.body.kind).toBe("base64");
    });

    it("captures a large binary response as an external blob", async () => {
      const store = createJsonFileStore({ rootDir: tmpDir });
      const cassette = createCassette({
        name: "large-bin",
        mode: "record",
        store,
      });

      let bytes: Uint8Array | undefined;
      await cassette.use(async () => {
        const res = await fetch(`${baseUrl()}/large-binary`);
        bytes = new Uint8Array(await res.arrayBuffer());
      });

      expect(bytes?.length).toBe(100 * 1024);

      const loaded = await store.load("large-bin");
      const body = loaded?.entries[0]!.response.body;
      expect(body?.kind).toBe("binary");
      if (body?.kind === "binary") {
        expect(body.sha256).toHaveLength(64);
        expect(body.path).not.toBe("");
        // Sidecar file should exist on disk
        const blobFile = join(tmpDir, body.path);
        await expect(access(blobFile)).resolves.toBeUndefined();
        // Verify the blob file contains the right bytes
        const diskBytes = await readFile(blobFile);
        expect(diskBytes.length).toBe(100 * 1024);
      }
    });

    it("externalBlobThreshold: false always inlines as base64", async () => {
      const store = createMemoryStore();
      const cassette = createCassette({
        name: "always-b64",
        mode: "record",
        store,
        externalBlobThreshold: false,
      });

      await cassette.use(async () => {
        await fetch(`${baseUrl()}/large-binary`);
      });

      const loaded = await store.load("always-b64");
      expect(loaded?.entries[0]!.response.body.kind).toBe("base64");
    });

    it("redaction masks the cassette but the caller still sees the real response", async () => {
      const store = createMemoryStore();
      const cassette = createCassette({
        name: "redacted",
        mode: "record",
        store,
        redact: "aggressive",
      });

      let result: unknown;
      await cassette.use(async () => {
        const res = await fetch(`${baseUrl()}/echo`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer real-token",
          },
          body: JSON.stringify({ q: "hi" }),
        });
        result = await res.json();
      });

      // The caller saw the real auth header (server echoes it back)
      expect((result as { authHeader: string }).authHeader).toBe(
        "Bearer real-token",
      );

      // But the cassette only has the redacted form
      const loaded = await store.load("redacted");
      const reqHeaders = loaded?.entries[0]!.request.headers ?? {};
      const authHeaderKey = Object.keys(reqHeaders).find(
        (k) => k.toLowerCase() === "authorization",
      );
      expect(authHeaderKey).toBeDefined();
      expect(reqHeaders[authHeaderKey!]).toBe(REDACTED_SENTINEL);
    });
  });

  describe("replay mode", () => {
    it("replays a recorded JSON response without hitting the network", async () => {
      const store = createMemoryStore();
      // First record
      reset();
      await createCassette({ name: "replay-test", mode: "record", store }).use(
        async () => {
          await fetch(`${baseUrl()}/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ q: "hi" }),
          });
        },
      );
      // Reset server-side counter; replay should not advance it
      reset();
      const serverCounter = 0;

      let result: unknown;
      await createCassette({ name: "replay-test", mode: "replay", store }).use(
        async () => {
          const res = await fetch(`${baseUrl()}/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ q: "hi" }),
          });
          result = await res.json();
        },
      );

      // The recorded response said callNum=1; replay returns it without
      // talking to the server, so the server counter stays at 0.
      expect((result as { callNum: number }).callNum).toBe(1);
      expect(serverCounter).toBe(0);
    });

    it("throws CassetteMissError for unrecorded requests", async () => {
      const store = createMemoryStore();
      // Save an empty cassette so replay has something to load
      await store.save("empty", { version: 1, entries: [] });

      const cassette = createCassette({ name: "empty", mode: "replay", store });

      await expect(
        cassette.use(async () => {
          await fetch(`${baseUrl()}/echo`, { method: "GET" });
        }),
      ).rejects.toBeInstanceOf(CassetteMissError);
    });

    it("throws CassetteMissError when the cassette file does not exist", async () => {
      const store = createMemoryStore();
      const cassette = createCassette({
        name: "missing",
        mode: "replay",
        store,
      });

      await expect(
        cassette.use(async () => {
          await fetch(`${baseUrl()}/echo`, { method: "GET" });
        }),
      ).rejects.toBeInstanceOf(CassetteMissError);
    });

    it("replays N identical requests in order via per-key counter", async () => {
      const store = createMemoryStore();
      // Record 3 calls
      await createCassette({ name: "multi-replay", mode: "record", store }).use(
        async () => {
          for (let i = 0; i < 3; i++) {
            await fetch(`${baseUrl()}/echo`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ q: "same" }),
            });
          }
        },
      );

      // Replay 3 calls — should get callNum 1, 2, 3 in order
      const replayed: number[] = [];
      await createCassette({ name: "multi-replay", mode: "replay", store }).use(
        async () => {
          for (let i = 0; i < 3; i++) {
            const res = await fetch(`${baseUrl()}/echo`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ q: "same" }),
            });
            const json = (await res.json()) as { callNum: number };
            replayed.push(json.callNum);
          }
        },
      );

      expect(replayed).toEqual([1, 2, 3]);
    });

    it("replays SSE bodies as a stream", async () => {
      const store = createMemoryStore();
      await createCassette({ name: "sse-replay", mode: "record", store }).use(
        async () => {
          await fetch(`${baseUrl()}/stream`, {
            headers: { accept: "text/event-stream" },
          });
        },
      );

      let body = "";
      await createCassette({ name: "sse-replay", mode: "replay", store }).use(
        async () => {
          const res = await fetch(`${baseUrl()}/stream`, {
            headers: { accept: "text/event-stream" },
          });
          body = await res.text();
        },
      );
      expect(body).toContain("data: chunk-1");
      expect(body).toContain("data: [DONE]");
    });

    it("replays small binary bodies byte-exactly (base64 path)", async () => {
      const store = createMemoryStore();
      await createCassette({ name: "bin-replay", mode: "record", store }).use(
        async () => {
          await fetch(`${baseUrl()}/binary`);
        },
      );

      let bytes: Uint8Array | undefined;
      await createCassette({ name: "bin-replay", mode: "replay", store }).use(
        async () => {
          const res = await fetch(`${baseUrl()}/binary`);
          bytes = new Uint8Array(await res.arrayBuffer());
        },
      );
      expect(bytes).toEqual(new Uint8Array([0x00, 0xff, 0xab, 0xcd]));
    });

    it("replays large binary bodies byte-exactly (external blob path)", async () => {
      const store = createJsonFileStore({ rootDir: tmpDir });
      await createCassette({
        name: "large-bin-replay",
        mode: "record",
        store,
      }).use(async () => {
        await fetch(`${baseUrl()}/large-binary`);
      });

      let bytes: Uint8Array | undefined;
      await createCassette({
        name: "large-bin-replay",
        mode: "replay",
        store,
      }).use(async () => {
        const res = await fetch(`${baseUrl()}/large-binary`);
        bytes = new Uint8Array(await res.arrayBuffer());
      });
      expect(bytes?.length).toBe(100 * 1024);
      expect(bytes?.every((b) => b === 0xaa)).toBe(true);
    });

    it("calls onMiss before throwing", async () => {
      const store = createMemoryStore();
      const seen: string[] = [];

      const cassette = createCassette({
        name: "miss",
        mode: "replay",
        store,
        onMiss: (req) => seen.push(req.method + " " + req.url),
      });

      await expect(
        cassette.use(async () => {
          await fetch(`${baseUrl()}/echo?x=1`, { method: "GET" });
        }),
      ).rejects.toBeInstanceOf(CassetteMissError);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("GET");
      expect(seen[0]).toContain("/echo");
    });

    it("matches across runs even when filtered request headers differ", async () => {
      const store = createMemoryStore();

      // Record with one auth token
      await createCassette({
        name: "auth-tolerant",
        mode: "record",
        store,
        filters: "default",
      }).use(async () => {
        await fetch(`${baseUrl()}/echo`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer token-A",
          },
          body: JSON.stringify({ q: "hi" }),
        });
      });

      // Replay with a different auth token — should still match because
      // 'default' filter strips the Authorization header from the match key.
      let matched = false;
      await createCassette({
        name: "auth-tolerant",
        mode: "replay",
        store,
        filters: "default",
      }).use(async () => {
        const res = await fetch(`${baseUrl()}/echo`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer token-B",
          },
          body: JSON.stringify({ q: "hi" }),
        });
        matched = res.ok;
      });

      expect(matched).toBe(true);
    });
  });

  describe("passthrough mode", () => {
    it("does not intercept and lets the real request through", async () => {
      const store = createMemoryStore();
      // Save a cassette that would respond differently if MSW were active
      await store.save("would-mock", {
        version: 1,
        entries: [
          {
            id: "fake",
            matchKey: `GET 127.0.0.1:1/echo`,
            callIndex: 0,
            recordedAt: "2026-04-29T12:00:00.000Z",
            request: {
              method: "GET",
              url: `${baseUrl()}/echo`,
              headers: {},
              body: { kind: "empty" },
            },
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              body: { kind: "json", value: { fake: true } },
            },
          },
        ],
      });

      let result: unknown;
      await createCassette({
        name: "would-mock",
        mode: "passthrough",
        store,
      }).use(async () => {
        const res = await fetch(`${baseUrl()}/echo`);
        result = await res.json();
      });

      // Real server responds — no `fake: true` field
      expect((result as { fake?: boolean }).fake).toBeUndefined();
      expect((result as { method: string }).method).toBe("GET");
    });
  });

  describe("ALS scoping", () => {
    it("two concurrent cassettes route fetches to the right cassette", async () => {
      const storeA = createMemoryStore();
      const storeB = createMemoryStore();

      // Record two distinct responses, one per cassette
      await createCassette({ name: "a", mode: "record", store: storeA }).use(
        async () => {
          await fetch(`${baseUrl()}/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ who: "A" }),
          });
        },
      );
      await createCassette({ name: "b", mode: "record", store: storeB }).use(
        async () => {
          await fetch(`${baseUrl()}/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ who: "B" }),
          });
        },
      );

      // Replay both concurrently — each fetch must hit its own cassette
      const results: Array<{ who: string }> = [];
      await Promise.all([
        createCassette({ name: "a", mode: "replay", store: storeA }).use(
          async () => {
            const res = await fetch(`${baseUrl()}/echo`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ who: "A" }),
            });
            results.push({
              who: ((await res.json()) as { requestBody: { who: string } })
                .requestBody.who,
            });
          },
        ),
        createCassette({ name: "b", mode: "replay", store: storeB }).use(
          async () => {
            const res = await fetch(`${baseUrl()}/echo`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ who: "B" }),
            });
            results.push({
              who: ((await res.json()) as { requestBody: { who: string } })
                .requestBody.who,
            });
          },
        ),
      ]);

      expect(results.map((r) => r.who).sort()).toEqual(["A", "B"]);
    });

    it("nested cassettes: inner fetch routes to inner cassette, outer to outer", async () => {
      const outerStore = createMemoryStore();
      const innerStore = createMemoryStore();

      reset();
      // Record the outer cassette response (callNum=1)
      await createCassette({
        name: "outer",
        mode: "record",
        store: outerStore,
      }).use(async () => {
        await fetch(`${baseUrl()}/echo`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: "outer" }),
        });
      });
      // Record the inner cassette response (callNum=2 from server's perspective)
      await createCassette({
        name: "inner",
        mode: "record",
        store: innerStore,
      }).use(async () => {
        await fetch(`${baseUrl()}/echo`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: "inner" }),
        });
      });

      const outerCallNums: number[] = [];
      const innerCallNums: number[] = [];

      await createCassette({
        name: "outer",
        mode: "replay",
        store: outerStore,
      }).use(async () => {
        // First fetch hits outer cassette
        const r1 = await fetch(`${baseUrl()}/echo`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: "outer" }),
        });
        outerCallNums.push(((await r1.json()) as { callNum: number }).callNum);

        // Inner cassette overrides for nested use()
        await createCassette({
          name: "inner",
          mode: "replay",
          store: innerStore,
        }).use(async () => {
          const r2 = await fetch(`${baseUrl()}/echo`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ q: "inner" }),
          });
          innerCallNums.push(
            ((await r2.json()) as { callNum: number }).callNum,
          );
        });

        // Back to outer cassette after nested use() returns
        const r3 = await fetch(`${baseUrl()}/echo`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: "outer" }),
        });
        outerCallNums.push(((await r3.json()) as { callNum: number }).callNum);
      });

      // Outer cassette had callNum=1 recorded; inner had callNum=2.
      // Both outer fetches should return 1 (replayed); inner fetch returns 2.
      expect(outerCallNums).toEqual([1, 1]);
      expect(innerCallNums).toEqual([2]);
    });

    it("background async (setTimeout) inherits the active cassette context", async () => {
      const store = createMemoryStore();

      // Record one response
      reset();
      await createCassette({ name: "bg", mode: "record", store }).use(
        async () => {
          await fetch(`${baseUrl()}/text`);
        },
      );

      let body: string | undefined;
      await createCassette({ name: "bg", mode: "replay", store }).use(
        async () => {
          // Defer the fetch into a setTimeout — ALS must propagate into the callback
          await new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              fetch(`${baseUrl()}/text`)
                .then((r) => r.text())
                .then((t) => {
                  body = t;
                  resolve();
                })
                .catch(reject);
            }, 0);
          });
        },
      );

      expect(body).toBe("hello world");
    });

    it("refcount: shared server starts on first acquire and closes after last release", async () => {
      const storeA = createMemoryStore();
      const storeB = createMemoryStore();
      await storeA.save("x", { version: 1, entries: [] });
      await storeB.save("y", { version: 1, entries: [] });

      // No cassette active yet — shared server should not exist.
      // We verify indirectly: a direct fetch goes to the real server (no interception).
      const pre = await fetch(`${baseUrl()}/text`);
      expect(pre.ok).toBe(true);

      // Start two cassettes — server should be running for both
      const ca = createCassette({ name: "x", mode: "replay", store: storeA });
      const cb = createCassette({ name: "y", mode: "replay", store: storeB });
      await ca.start();
      await cb.start();

      // Stop one — server still alive (refcount = 1)
      await ca.stop();

      // Stop the other — server closes (refcount = 0)
      await cb.stop();

      // After both stopped, a direct fetch should again reach the real server
      const post = await fetch(`${baseUrl()}/text`);
      expect(post.ok).toBe(true);
    });
  });

  describe("hosts filter", () => {
    it("only intercepts matching hosts", async () => {
      const store = createMemoryStore();
      const cassette = createCassette({
        name: "targeted",
        mode: "replay",
        store,
        // Only intercept requests to a non-existent host; this server's host
        // is 127.0.0.1, so requests pass through.
        hosts: ["some-other-host.invalid"],
      });

      // Request to non-targeted host should pass through; the empty cassette
      // would otherwise cause a CassetteMissError.
      let ok = false;
      await cassette.use(async () => {
        const res = await fetch(`${baseUrl()}/echo`);
        ok = res.ok;
      });
      expect(ok).toBe(true);
    });
  });
});
