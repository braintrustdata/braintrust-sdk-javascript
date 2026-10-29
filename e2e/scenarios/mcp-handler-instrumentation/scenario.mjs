import "./configure.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { injectTraceContext, traced, wrapMCPHandler } from "braintrust";
import { z } from "zod";
import { runMain, runTracedScenario } from "../../helpers/provider-runtime.mjs";

const packageName = process.env.MCP_HANDLER_PACKAGE;
const { createMcpHandler } =
  process.env.MCP_HANDLER_CJS === "1"
    ? createRequire(import.meta.url)(packageName)
    : await import(packageName);
const createHandler =
  process.env.MCP_HANDLER_WRAPPED === "1"
    ? wrapMCPHandler(createMcpHandler)
    : createMcpHandler;
const v1 = packageName.includes("v1");
const schema = (shape) => (v1 ? shape : z.object(shape));

runMain(async () => {
  await runTracedScenario({
    projectNameBase: "tmp-luca",
    rootName: "mcp-handler-instrumentation-root",
    metadata: { scenario: "mcp-handler-instrumentation" },
    callback: async () => {
      const createServerHandler = () =>
        createHandler(
          async (server) => {
            await Promise.resolve();
            server.registerTool(
              "get_weather",
              {
                inputSchema: schema({ city: z.string() }),
              },
              async ({ city }) =>
                traced(
                  async () => {
                    await Promise.resolve();
                    return {
                      content: [
                        {
                          type: "text",
                          text: `Sunny in ${city}`,
                          _meta: { private: "hidden" },
                        },
                      ],
                    };
                  },
                  { name: "weather-lookup" },
                ),
            );
            server.registerTool("get_alerts", {}, async () => {
              throw new Error("Alert service unavailable");
            });
            server.registerTool(
              "report_progress",
              { inputSchema: schema({}) },
              async (_args, extra) => {
                await server.server.notification(
                  {
                    method: "notifications/progress",
                    params: {
                      progressToken: "progress",
                      progress: 1,
                      total: 1,
                      message: "done",
                    },
                  },
                  { relatedRequestId: extra.mcpReq?.id ?? extra.requestId },
                );
                return { content: [{ type: "text", text: "done" }] };
              },
            );
            server.registerResource(
              "forecast-notes",
              "notes://forecast",
              {},
              async (uri) => ({
                contents: [{ uri: uri.href, text: "Bring an umbrella." }],
              }),
            );
            server.registerPrompt(
              "forecast",
              {
                argsSchema: schema({ city: z.string() }),
              },
              ({ city }) => ({
                messages: [
                  {
                    role: "user",
                    content: { type: "text", text: `Forecast for ${city}?` },
                  },
                ],
              }),
            );
          },
          { serverInfo: { name: "braintrust-e2e-weather", version: "1.0.0" } },
          ...(v1 ? [{ disableSse: true }] : []),
        );
      // Older v1 adapters retain a single-use SDK transport on the handler.
      const handler =
        packageName === "mcp-handler-v1"
          ? (request) => createServerHandler()(request)
          : createServerHandler();

      async function request(
        method,
        params,
        { modern = false, propagate = true } = {},
      ) {
        const response = await handler(
          new Request("http://mcp.test/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": modern ? "2026-07-28" : "2025-11-25",
              ...(modern
                ? { "mcp-method": method, "mcp-name": params.name }
                : {}),
              authorization: "Bearer private-token",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params: {
                ...params,
                _meta: {
                  ...(modern
                    ? {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientCapabilities": {},
                        "io.modelcontextprotocol/clientInfo": {
                          name: "braintrust-e2e-client",
                          version: "1.0.0",
                        },
                      }
                    : {}),
                  ...(propagate
                    ? injectTraceContext()
                    : { traceparent: "invalid" }),
                  private: "hidden",
                },
              },
            }),
          }),
        );
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const messages = response.headers
          .get("content-type")
          .includes("text/event-stream")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => JSON.parse(line.slice(5)))
          : [JSON.parse(text)];
        return messages.find((message) => message.id === 1);
      }

      const initialized = await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "braintrust-e2e-client", version: "1.0.0" },
      });
      assert.equal(
        initialized.result.serverInfo.name,
        "braintrust-e2e-weather",
      );
      // Both requests use id=1 on independent stateless transports.
      const weather = await Promise.all(
        ["Vienna", "Paris"].map((city) =>
          request("tools/call", { name: "get_weather", arguments: { city } }),
        ),
      );
      assert.equal(weather[0].result.content[0].text, "Sunny in Vienna");
      assert.equal(weather[1].result.content[0].text, "Sunny in Paris");
      assert.equal(
        (
          await request("tools/call", {
            name: "report_progress",
            arguments: {},
          })
        ).result.content[0].text,
        "done",
      );
      assert.ok((await request("tools/list", {})).result.tools.length >= 2);
      assert.ok(
        (await request("resources/read", { uri: "notes://forecast" })).result
          .contents,
      );
      assert.ok(
        (
          await request("prompts/get", {
            name: "forecast",
            arguments: { city: "Vienna" },
          })
        ).result.messages,
      );
      assert.equal(
        (await request("tools/call", { name: "get_alerts", arguments: {} }))
          .result.isError,
        true,
      );
      const invalid = await request("tools/call", {
        name: "get_weather",
        arguments: { city: 42 },
      });
      assert.ok(invalid.error || invalid.result.isError);
      assert.equal((await request("acme/missing", {})).error.code, -32601);
      await request("ping", {}, { propagate: false });
      if (!v1) {
        const modern = await request(
          "tools/call",
          { name: "get_weather", arguments: { city: "Tokyo" } },
          { modern: true },
        );
        assert.equal(modern.result.content[0].text, "Sunny in Tokyo");
      }
    },
  });
  // mcp-handler v1 retains a server cleanup interval after all requests finish.
  process.exit(0);
});
