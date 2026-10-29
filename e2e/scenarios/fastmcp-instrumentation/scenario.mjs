import "./configure.mjs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { injectTraceContext, traced, wrapFastMCP } from "braintrust";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { MINIMAL_PNG_BASE64 } from "../../helpers/media-fixtures.mjs";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const dependency = process.env.FASTMCP_PACKAGE;
const fastmcp =
  process.env.FASTMCP_CJS === "1"
    ? createRequire(import.meta.url)(dependency)
    : await import(dependency);
if (process.env.FASTMCP_WRAPPED === "1") {
  assert.equal(wrapFastMCP(fastmcp), fastmcp);
  wrapFastMCP(fastmcp);
}

await runTracedScenario({
  rootName: "fastmcp-instrumentation-root",
  projectNameBase: "tmp-luca",
  metadata: { scenario: "fastmcp-instrumentation" },
  async callback() {
    for (const stateless of [false, true]) {
      const listener = createServer();
      await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const { port } = listener.address();
      await new Promise((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      const server = new fastmcp.FastMCP({
        name: "braintrust-e2e-fastmcp",
        version: "1.0.0",
        ping: { enabled: false },
      });
      server.addTool({
        name: "get_weather",
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) =>
          traced(async () => `Sunny in ${city}`, { name: "weather-lookup" }),
      });
      server.addTool({
        name: "get_alerts",
        execute: async () => {
          throw new fastmcp.UserError("Alert service unavailable");
        },
      });
      server.addTool({
        name: "render_map",
        execute: async () => ({
          content: [
            { type: "image", data: MINIMAL_PNG_BASE64, mimeType: "image/png" },
          ],
        }),
      });
      server.addResource({
        uri: "notes://forecast",
        name: "forecast-notes",
        mimeType: "text/plain",
        load: async () => ({ text: "Bring an umbrella." }),
      });
      server.addPrompt({
        name: "forecast",
        arguments: [{ name: "city", required: true }],
        load: async ({ city }) => `What is the forecast for ${city}?`,
      });
      await server.start({
        transportType: "httpStream",
        httpStream: { host: "127.0.0.1", port, stateless },
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      );
      const send = transport.send;
      transport.send = function (message, ...args) {
        if (typeof message.method === "string") {
          message = {
            ...message,
            params: {
              ...message.params,
              _meta: { ...message.params?._meta, ...injectTraceContext() },
            },
          };
        }
        return send.call(this, message, ...args);
      };
      const client = new Client({
        name: "braintrust-e2e-client",
        version: "1.0.0",
      });
      try {
        await runOperation(
          `fastmcp-${stateless ? "stateless" : "session"}`,
          "mcp",
          async () => {
            await client.connect(transport);
            assert.ok(
              (await client.listTools()).tools.some(
                (tool) => tool.name === "get_weather",
              ),
            );
            const weather = await client.callTool({
              name: "get_weather",
              arguments: { city: "Vienna" },
            });
            assert.deepEqual(weather.content, [
              { type: "text", text: "Sunny in Vienna" },
            ]);
            assert.equal(
              (await client.callTool({ name: "get_alerts" })).isError,
              true,
            );
            await client.callTool({ name: "render_map" });
            await client.readResource({ uri: "notes://forecast" });
            await client.getPrompt({
              name: "forecast",
              arguments: { city: "Vienna" },
            });
            await client.ping();
            await client.close();
          },
        );
      } finally {
        await client.close();
        await server.stop();
      }
    }
  },
});
