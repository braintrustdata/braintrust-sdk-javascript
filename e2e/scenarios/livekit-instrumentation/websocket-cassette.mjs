// Real protocol recordings only. Never save HTTP headers or credentials.
import { WebSocket, WebSocketServer } from "ws";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { dirname } from "node:path";
import assert from "node:assert/strict";
export async function websocketCassette(
  path,
  record,
  { concurrentAudio = false, burst = false } = {},
) {
  const events = record ? [] : JSON.parse(await readFile(path, "utf8"));
  let index = 0,
    failure,
    socket,
    upstream;
  let disconnected = false;
  let connectionCount = 0;
  const ids = new Map();
  const consumed = new Set();
  const isAudio = (message) => message.type === "session.input_audio.append";
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
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (index < events.length && socket.readyState === WebSocket.OPEN) {
        if (events[index].direction === "send") {
          if (!consumed.delete(index)) break;
          index++;
        } else if (
          events[index].direction === "disconnect" ||
          events[index].direction === "connect"
        )
          break;
        else {
          const message = remap(events[index++].message);
          socket.send(JSON.stringify(message));
          // Preserve protocol order without waiting on the instrumented code.
          // Burst replay also exercises completion arriving before async setup.
          if (!burst) await setImmediate();
        }
      }
    } catch (error) {
      failure = error;
      socket?.close();
    } finally {
      pumping = false;
    }
  };
  server.on("connection", (client, request) => {
    if (socket && !disconnected) {
      failure ??= new Error("Unexpected realtime reconnect");
      client.close();
      return;
    }
    if (connectionCount > 0) {
      if (record) events.push({ direction: "connect" });
      else {
        assert.equal(
          events[index]?.direction,
          "connect",
          "Expected recorded reconnect",
        );
        index++;
      }
    }
    connectionCount++;
    disconnected = false;
    socket = client;
    if (record) {
      const url = new URL(request.url, "wss://api.openai.com");
      // LiveKit adds model routing for gateways, but OpenAI transcription
      // selects its model in session.update rather than the upgrade URL.
      if (url.searchParams.get("intent") === "transcription")
        url.searchParams.delete("model");
      const remote = (upstream = new WebSocket(url, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      }));
      const pending = [];
      client.on("message", (data) => {
        const message = JSON.parse(data.toString());
        events.push({ direction: "send", message });
        if (remote.readyState === WebSocket.OPEN) remote.send(data.toString());
        else pending.push(data.toString());
      });
      remote.on("open", () =>
        pending.splice(0).forEach((data) => remote.send(data)),
      );
      remote.on("message", (data) => {
        const message = JSON.parse(data.toString());
        events.push({ direction: "receive", message });
        if (client.readyState === WebSocket.OPEN) client.send(data.toString());
      });
      remote.on("error", () => {
        failure = new Error("Realtime upstream connection failed");
        client.close();
      });
      client.on("close", () => remote.close());
    } else {
      client.on("message", (data) => {
        try {
          const actual = JSON.parse(data.toString());
          // A duplex microphone keeps sending while tools finish. Validate both
          // ordered lanes in full without depending on their scheduler interleave.
          const expected = concurrentAudio
            ? events.findIndex(
                (event, i) =>
                  i >= index &&
                  event.direction === "send" &&
                  !consumed.has(i) &&
                  isAudio(event.message) === isAudio(actual),
              )
            : index;
          assert.equal(
            events[expected]?.direction,
            "send",
            `Unexpected outgoing message at ${index}`,
          );
          match(actual, events[expected].message);
          consumed.add(expected);
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
    disconnect() {
      assert(
        socket?.readyState === WebSocket.OPEN,
        "No active connection to disconnect",
      );
      if (record) events.push({ direction: "disconnect" });
      else {
        assert.equal(
          events[index]?.direction,
          "disconnect",
          "Disconnect before recorded messages completed",
        );
        index++;
      }
      disconnected = true;
      socket.terminate();
      upstream?.terminate();
    },
    get connections() {
      return connectionCount;
    },
    async close() {
      socket?.terminate();
      upstream?.terminate();
      await new Promise((resolve) => server.close(resolve));
      if (failure) throw failure;
      if (record) {
        await mkdir(dirname(path), { recursive: true });
        // Provider session IDs can resemble access tokens. Preserve references
        // with synthetic IDs in the cassette, without changing live traffic.
        const sessionIds = new Map();
        for (const event of events) {
          const id = event.message?.session?.id;
          if (typeof id === "string" && !sessionIds.has(id))
            sessionIds.set(id, `session_fixture_${sessionIds.size + 1}`);
        }
        const serialized = JSON.stringify(
          events,
          (_key, value) => sessionIds.get(value) ?? value,
          2,
        );
        await writeFile(path, serialized + "\n");
      } else
        assert.equal(
          index,
          events.length,
          "WebSocket cassette not fully consumed",
        );
    },
  };
}
