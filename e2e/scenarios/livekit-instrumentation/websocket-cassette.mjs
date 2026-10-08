// Real protocol recordings only. Never save HTTP headers or credentials.
import { WebSocket, WebSocketServer } from "ws";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import assert from "node:assert/strict";
export async function websocketCassette(path, record) {
  const events = record ? [] : JSON.parse(await readFile(path, "utf8"));
  let index = 0,
    failure,
    socket,
    upstream;
  const ids = new Map();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  function remap(value) {
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, remap(v)]),
      );
    return typeof value === "string" ? (ids.get(value) ?? value) : value;
  }
  function match(actual, expected, key = "") {
    if (
      typeof actual === "string" &&
      typeof expected === "string" &&
      ["event_id", "id", "previous_item_id", "client_event_id"].includes(key)
    ) {
      if (!ids.has(expected)) ids.set(expected, actual);
      assert.equal(actual, ids.get(expected));
      return;
    }
    if (Array.isArray(expected)) {
      assert.equal(actual.length, expected.length);
      expected.forEach((v, i) => match(actual[i], v));
      return;
    }
    if (expected && typeof expected === "object") {
      assert.deepEqual(
        Object.keys(actual).sort(),
        Object.keys(expected).sort(),
      );
      for (const [k, v] of Object.entries(expected)) match(actual[k], v, k);
      return;
    }
    assert.deepEqual(actual, expected);
  }
  const pump = () => {
    while (
      index < events.length &&
      events[index].direction === "receive" &&
      socket.readyState === WebSocket.OPEN
    )
      socket.send(JSON.stringify(remap(events[index++].message)));
  };
  server.on("connection", (client, request) => {
    if (socket) {
      failure ??= new Error("Unexpected realtime reconnect");
      client.close();
      return;
    }
    socket = client;
    if (record) {
      upstream = new WebSocket(`wss://api.openai.com${request.url}`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });
      const pending = [];
      client.on("message", (data) => {
        const message = JSON.parse(data.toString());
        events.push({ direction: "send", message });
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(data.toString());
        else pending.push(data.toString());
      });
      upstream.on("open", () =>
        pending.splice(0).forEach((data) => upstream.send(data)),
      );
      upstream.on("message", (data) => {
        const message = JSON.parse(data.toString());
        events.push({ direction: "receive", message });
        if (client.readyState === WebSocket.OPEN) client.send(data.toString());
      });
      upstream.on("error", () => {
        failure = new Error("Realtime upstream connection failed");
        client.close();
      });
      client.on("close", () => upstream.close());
    } else {
      client.on("message", (data) => {
        try {
          assert.equal(
            events[index]?.direction,
            "send",
            `Unexpected outgoing message at ${index}`,
          );
          match(JSON.parse(data.toString()), events[index++].message);
          pump();
        } catch (error) {
          console.error("WebSocket cassette mismatch at", index, error);
          failure = error;
          client.close();
        }
      });
      pump();
    }
  });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      socket?.terminate();
      upstream?.terminate();
      await new Promise((resolve) => server.close(resolve));
      if (failure) throw failure;
      if (record) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(events, null, 2) + "\n");
      } else
        assert.equal(
          index,
          events.length,
          "WebSocket cassette not fully consumed",
        );
    },
  };
}
