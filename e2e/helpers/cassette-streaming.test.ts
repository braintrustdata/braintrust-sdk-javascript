import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCassetteServer,
  createJsonFileStore,
} from "@braintrust/seinfeld";
import { expect, test, vi } from "vitest";
import { buildResponse } from "../../dev-packages/seinfeld/src/http";

for (const { contentType, firstChunk, lastChunk } of [
  {
    contentType: "text/plain",
    firstChunk: Buffer.from("send the next message"),
    lastChunk: Buffer.from("; finished"),
  },
  {
    // Connect can return binary protobuf frames with an SSE content type.
    contentType: "text/event-stream",
    firstChunk: Buffer.from([0, 0, 0, 0, 2, 0xff, 0xfe]),
    lastChunk: Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d]),
  },
]) {
  for (const httpVersion of ["1.1", "2"] as const) {
    test(`records an interactive HTTP/${httpVersion} ${contentType} stream and replays it`, async () => {
      const upstream =
        httpVersion === "2" ? createHttp2Server() : createServer();
      upstream.on("request", (req, res) => {
        res.writeHead(200, { "content-type": contentType });
        req.once("data", () => res.write(firstChunk));
        req.on("end", () => res.end(lastChunk));
      });
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      const rootDir = await mkdtemp(join(tmpdir(), "cassette-streaming-"));
      const store = createJsonFileStore({ rootDir });
      const options = {
        name: "interactive",
        store,
        routes: [{ prefix: "/provider", upstreamOrigin: upstreamUrl }],
        streamingRequests:
          httpVersion === "2" ? [{ url: /\/run$/, httpVersion }] : [/\/run$/],
      };
      const recorder = createCassetteServer({ ...options, mode: "record" });
      const replay = createCassetteServer({ ...options, mode: "replay" });
      try {
        await recorder.start();
        const body = await new Promise<Buffer>((resolve, reject) => {
          const req = request(`${recorder.url}/provider/run`, {
            method: "POST",
          });
          req.setTimeout(2_000, () => req.destroy(new Error("Stream stalled")));
          req.on("error", reject);
          req.on("response", (res) => {
            const chunks: Buffer[] = [];
            res.once("data", () => req.end("second message"));
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          });
          req.write("first message");
        });
        expect(body).toEqual(Buffer.concat([firstChunk, lastChunk]));
        await recorder.stop();
        await replay.start();
        const response = await fetch(`${replay.url}/provider/run`, {
          method: "POST",
          body: "a different live request body",
        });
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
        await replay.stop();
      } finally {
        await recorder.stop();
        await replay.stop();
        upstream.close();
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  }
}

test("replays wire chunks at their recorded delays", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    const response = await buildResponse({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: {
        kind: "base64",
        value: Buffer.from([0xff, 0xfe, 1, 2]).toString("base64"),
      },
      streamChunks: [
        { size: 2, delayMs: 10 },
        { size: 2, delayMs: 40 },
      ],
    });
    const reader = response.body!.getReader();
    const received = vi.fn();
    const first = reader.read().then(received);
    await vi.advanceTimersByTimeAsync(9);
    expect(received).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(received).toHaveBeenLastCalledWith({
      done: false,
      value: new Uint8Array([0xff, 0xfe]),
    });
    const second = reader.read().then(received);
    await vi.advanceTimersByTimeAsync(39);
    expect(received).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(received).toHaveBeenLastCalledWith({
      done: false,
      value: new Uint8Array([1, 2]),
    });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  } finally {
    vi.useRealTimers();
  }
});
