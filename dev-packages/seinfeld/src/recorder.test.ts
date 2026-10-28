import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCassetteServer } from "./recorder";
import { encodeBody } from "./serializer";
import { createJsonFileStore } from "./store";

type Upstream = {
  origin: string;
  responses: ServerResponse[];
  close(): Promise<void>;
};

async function startUpstream(): Promise<Upstream> {
  const responses: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.flushHeaders();
    responses.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    responses,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value } = await reader.read();
  return Buffer.from(value ?? new Uint8Array()).toString("utf8");
}

describe("streaming record and replay", () => {
  let rootDir: string;
  let upstream: Upstream;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "seinfeld-test-"));
    upstream = await startUpstream();
  });

  afterEach(async () => {
    await upstream.close();
    await rm(rootDir, { force: true, recursive: true });
  });

  function server(mode: "record" | "replay") {
    return createCassetteServer({
      mode,
      name: "stream",
      routes: [{ prefix: "/up", upstreamOrigin: upstream.origin }],
      store: createJsonFileStore({ rootDir }),
      streamingRequests: [/\/stream(?:\?|$)/],
    });
  }

  async function readCassette() {
    return JSON.parse(
      await readFile(path.join(rootDir, "stream.cassette.json"), "utf8"),
    ) as {
      entries: Array<{
        callIndex: number;
        response: { body: { value?: string }; incomplete?: true };
      }>;
    };
  }

  it("forwards chunks before upstream ends", async () => {
    const recorder = server("record");
    await recorder.start();
    const response = await fetch(`${recorder.url}/up/stream`, {
      body: "x",
      method: "POST",
    });
    const upstreamRes = await waitFor(() => upstream.responses[0]);
    upstreamRes.write("first");
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe("first");
    upstreamRes.end("second");
    expect(await readChunk(reader)).toBe("second");
    await reader.read();
    await recorder.stop();

    const cassette = await readCassette();
    expect(cassette.entries).toHaveLength(1);
    expect(cassette.entries[0]?.response.incomplete).toBeUndefined();
  });

  it("records a stream the client cancelled and holds it open on replay", async () => {
    const recorder = server("record");
    await recorder.start();
    const controller = new AbortController();
    const response = await fetch(`${recorder.url}/up/stream`, {
      body: "x",
      method: "POST",
      signal: controller.signal,
    });
    const upstreamRes = await waitFor(() => upstream.responses[0]);
    upstreamRes.write("partial");
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe("partial");
    controller.abort();
    await reader.read().catch(() => undefined);
    await recorder.stop();

    const cassette = await readCassette();
    expect(cassette.entries).toHaveLength(1);
    expect(cassette.entries[0]?.response.incomplete).toBe(true);

    const replayer = server("replay");
    await replayer.start();
    const replayController = new AbortController();
    const replayed = await fetch(`${replayer.url}/up/stream`, {
      body: "x",
      method: "POST",
      signal: replayController.signal,
    });
    const replayReader = replayed.body!.getReader();
    expect(await readChunk(replayReader)).toBe("partial");
    const next = await Promise.race([
      replayReader.read().then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("open"), 100)),
    ]);
    expect(next).toBe("open");
    replayController.abort();
    await replayer.stop();
  });

  it("keeps a replayed duplex response open until the client stops writing", async () => {
    const recorder = server("record");
    await recorder.start();
    const recorded = await fetch(`${recorder.url}/up/stream`, {
      body: "x",
      method: "POST",
    });
    (await waitFor(() => upstream.responses[0])).end("done");
    expect(await recorded.text()).toBe("done");
    await recorder.stop();

    const replayer = server("replay");
    await replayer.start();
    const events: string[] = [];
    const req = httpRequest(`${replayer.url}/up/stream`, { method: "POST" });
    const finished = new Promise<void>((resolve, reject) => {
      req.on("response", (res) => {
        res.on("data", (chunk) => events.push(`data:${chunk}`));
        res.on("end", () => {
          events.push("end");
          resolve();
        });
      });
      req.on("error", reject);
    });
    req.write("first");
    await waitFor(() => (events.length > 0 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 750));
    // Still writable after the recorded bytes were delivered.
    req.write("second");
    // The next write happens after the original idle deadline, but within
    // the renewed grace period started by the second write.
    await new Promise((resolve) => setTimeout(resolve, 2400));
    req.write("third");
    expect(events).toEqual(["data:done"]);
    req.end();
    await finished;
    expect(events).toEqual(["data:done", "end"]);
    await replayer.stop();
  });

  it("ends a duplex response when the client waits to finish its request", async () => {
    const recorder = server("record");
    await recorder.start();
    const recorded = await fetch(`${recorder.url}/up/stream`, {
      body: "x",
      method: "POST",
    });
    (await waitFor(() => upstream.responses[0])).end("done");
    expect(await recorded.text()).toBe("done");
    await recorder.stop();

    const replayer = server("replay");
    await replayer.start();
    const req = httpRequest(`${replayer.url}/up/stream`, { method: "POST" });
    try {
      const finished = new Promise<string>((resolve, reject) => {
        req.on("response", (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => {
            req.end();
            resolve(body);
          });
          res.on("error", reject);
        });
        req.on("error", reject);
      });
      req.write("first");
      expect(
        await Promise.race([
          finished,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Replay response did not end")),
              4500,
            ),
          ),
        ]),
      ).toBe("done");
    } finally {
      req.destroy();
      await replayer.stop();
    }
  });

  it("indexes concurrent streams in request order", async () => {
    const recorder = server("record");
    await recorder.start();
    const first = await fetch(`${recorder.url}/up/stream`, {
      body: "a",
      method: "POST",
    });
    const firstUpstream = await waitFor(() => upstream.responses[0]);
    const second = await fetch(`${recorder.url}/up/stream`, {
      body: "b",
      method: "POST",
    });
    const secondUpstream = await waitFor(() => upstream.responses[1]);
    secondUpstream.end("second");
    expect(await second.text()).toBe("second");
    firstUpstream.end("first");
    expect(await first.text()).toBe("first");
    await recorder.stop();

    const cassette = await readCassette();
    const byIndex = [...cassette.entries].sort(
      (a, b) => a.callIndex - b.callIndex,
    );
    expect(
      byIndex.map((entry) =>
        Buffer.from(entry.response.body.value ?? "", "base64").toString(),
      ),
    ).toEqual(["first", "second"]);
  });
});

describe("encodeBody", () => {
  it("keeps binary event-stream bodies byte for byte", () => {
    const bytes = new Uint8Array([0, 0, 0, 0, 5, 0xff, 0x0a, 0x0a, 0x01]);
    const body = encodeBody(bytes, "text/event-stream");
    expect(body.kind).toBe("base64");
  });

  it("still splits real SSE bodies into chunks", () => {
    const bytes = new TextEncoder().encode("data: a\n\ndata: b\n\n");
    const body = encodeBody(bytes, "text/event-stream");
    expect(body).toMatchObject({ kind: "sse" });
  });
});
