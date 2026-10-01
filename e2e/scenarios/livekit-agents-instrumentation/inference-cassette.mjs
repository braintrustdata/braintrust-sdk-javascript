import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// The shared cassette server records HTTP. LiveKit speech uses WebSockets;
// retain the real bidirectional messages here, without persisting auth headers.
// Replay checks every client message and releases recorded server messages only
// after their preceding client messages have arrived. It never contacts LiveKit.
// Hash media messages to keep assertion failures compact. JSON field order is
// stable in the SDK; all field values remain significant.
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function startInferenceCassette(
  scenarioDir,
  cassettePath,
  record,
) {
  const require = createRequire(path.join(scenarioDir, "package.json"));
  const sdkRequire = createRequire(require.resolve("@livekit/agents"));
  const { WebSocket, WebSocketServer } = sdkRequire("ws");
  const connections = record
    ? []
    : JSON.parse(await readFile(cassettePath, "utf8"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const upstreams = new Set();
  const cursors = [];
  const used = new Set();
  const failures = [];
  let connectionIndex = 0;
  server.on("connection", (client, request) => {
    connectionIndex++;
    const fail = (error) => {
      failures.push(error);
      client.close(1011, "Cassette failure");
    };
    client.on("error", fail);
    const url = request.url;
    if (!/^\/v1\/(stt|tts)(\?model=[^&]+)?$/.test(url)) {
      fail(new Error(`Unexpected LiveKit speech path: ${url}`));
      return;
    }
    if (record) {
      const connection = { url, messages: [] };
      connections.push(connection);
      const upstream = new WebSocket(
        `wss://agent-gateway.livekit.cloud${url}`,
        {
          headers: { authorization: request.headers.authorization },
          handshakeTimeout: 10_000,
        },
      );
      upstreams.add(upstream);
      const pending = [];
      client.on("message", (data, binary) => {
        connection.messages.push({
          from: "client",
          binary,
          data: binary ? data.toString("base64") : JSON.parse(data.toString()),
        });
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(data, { binary });
        else pending.push({ data, binary });
      });
      upstream.on("open", () => {
        for (const message of pending)
          upstream.send(message.data, { binary: message.binary });
        pending.length = 0;
      });
      upstream.on("message", (data, binary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        connection.messages.push({
          from: "server",
          binary,
          data: binary ? data.toString("base64") : JSON.parse(data.toString()),
        });
        client.send(data, { binary });
      });
      upstream.on("error", fail);
      upstream.on("close", () => {
        upstreams.delete(upstream);
        client.close();
      });
      client.on("close", () => {
        if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
        else upstream.close();
      });
    } else {
      // Prewarming STT and TTS may race. Match within each endpoint rather
      // than imposing an order on independent model connections.
      const index = connections.findIndex(
        (entry, index) => entry.url === url && !used.has(index),
      );
      used.add(index);
      const connection = connections[index];
      if (!connection || connection.url !== url) {
        fail(
          new Error(`Unrecorded LiveKit speech connection ${index}: ${url}`),
        );
        return;
      }
      let cursor = 0;
      const sendRecorded = () => {
        while (connection.messages[cursor]?.from === "server") {
          const message = connection.messages[cursor++];
          client.send(
            message.binary
              ? Buffer.from(message.data, "base64")
              : JSON.stringify(message.data),
            { binary: message.binary },
          );
        }
        cursors[index] = cursor;
      };
      client.on("message", (data, binary) => {
        try {
          const expected = connection.messages[cursor];
          assert.equal(
            expected?.from,
            "client",
            `Unexpected client message in connection ${index}`,
          );
          assert.equal(binary, expected.binary);
          const actual = binary
            ? data.toString("base64")
            : JSON.parse(data.toString());
          assert.equal(
            hash(actual),
            hash(expected.data),
            `LiveKit ${url}: client message ${cursor} (${actual.type ?? "binary"}) changed`,
          );
          cursor++;
          sendRecorded();
        } catch (error) {
          fail(error);
        }
      });
      sendRecorded();
    }
  });
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    async stop() {
      for (const upstream of upstreams) upstream.terminate();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
      if (failures.length) throw failures[0];
      if (record) {
        await mkdir(path.dirname(cassettePath), { recursive: true });
        await writeFile(
          cassettePath,
          JSON.stringify(connections, null, 2) + "\n",
        );
      } else {
        assert.equal(
          connectionIndex,
          connections.length,
          "Unused LiveKit speech connections",
        );
        for (const [index, connection] of connections.entries())
          assert.equal(
            cursors[index],
            connection.messages.length,
            `Unused LiveKit speech messages in connection ${index}`,
          );
      }
    },
  };
}
