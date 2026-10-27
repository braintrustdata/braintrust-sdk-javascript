import { randomUUID } from "node:crypto";
import { traced, wrapMCPServer } from "braintrust";
import { z } from "zod";
import { MINIMAL_PNG_BASE64 } from "../../helpers/media-fixtures.mjs";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "mcp-instrumentation-root";
export const SCENARIO_NAME = "mcp-instrumentation";

const DEFAULT_PACKAGES = {
  v1: { server: "mcp-sdk-v1-latest" },
  v2: { client: "mcp-client-v2-latest", server: "mcp-server-v2-latest" },
};

/** Load the server and client SDK surface through `import()` or `require()`. */
export async function loadMCPModules(load) {
  const line = process.env.MCP_SDK_LINE ?? "v1";
  const serverPackage =
    process.env.MCP_SERVER_PACKAGE_NAME ?? DEFAULT_PACKAGES[line].server;

  if (line === "v1") {
    const [mcp, http, client, clientHttp, inMemory] = await Promise.all(
      [
        "server/mcp.js",
        "server/webStandardStreamableHttp.js",
        "client/index.js",
        "client/streamableHttp.js",
        "inMemory.js",
      ].map((path) => load(`${serverPackage}/${path}`)),
    );
    return {
      Client: client.Client,
      InMemoryTransport: inMemory.InMemoryTransport,
      McpServer: mcp.McpServer,
      // v1 accepts Zod raw shapes for tool and prompt arguments.
      schema: (shape) => shape,
      StreamableHTTPClientTransport: clientHttp.StreamableHTTPClientTransport,
      WebStandardStreamableHTTPServerTransport:
        http.WebStandardStreamableHTTPServerTransport,
    };
  }

  const [server, client] = await Promise.all([
    load(serverPackage),
    load(DEFAULT_PACKAGES.v2.client),
  ]);
  return {
    Client: client.Client,
    InMemoryTransport: server.InMemoryTransport,
    McpServer: server.McpServer,
    schema: (shape) => z.object(shape),
    StreamableHTTPClientTransport: client.StreamableHTTPClientTransport,
    WebStandardStreamableHTTPServerTransport:
      server.WebStandardStreamableHTTPServerTransport,
  };
}

function createServer(mcp, decorateServer) {
  const baseServer = new mcp.McpServer({
    name: "braintrust-e2e-weather",
    version: "1.0.0",
  });
  const server = decorateServer ? decorateServer(baseServer) : baseServer;

  server.registerTool(
    "get_weather",
    {
      description: "Get the current weather for a city",
      inputSchema: mcp.schema({ city: z.string() }),
    },
    async ({ city }) =>
      traced(
        async () => ({
          content: [
            {
              type: "text",
              text: `Sunny in ${city}`,
              _meta: { private: "omitted" },
            },
          ],
          structuredContent: { _meta: { application: "preserved" } },
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "braintrust-e2e-weather",
              version: "1.0.0",
            },
            private: "omitted",
          },
        }),
        { name: "weather-lookup" },
      ),
  );
  server.registerTool(
    "render_map",
    { description: "Render a weather map" },
    async () => ({
      content: [
        { type: "image", data: MINIMAL_PNG_BASE64, mimeType: "image/png" },
      ],
    }),
  );
  server.registerTool(
    "get_alerts",
    { description: "Get weather alerts" },
    async () => {
      throw new Error("Alert service unavailable");
    },
  );
  server.registerResource(
    "forecast-notes",
    "notes://forecast",
    { mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, text: "Bring an umbrella." }],
    }),
  );
  server.registerPrompt(
    "forecast",
    {
      description: "Ask for a forecast",
      argsSchema: mcp.schema({ city: z.string() }),
    },
    ({ city }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `What is the forecast for ${city}?` },
        },
      ],
    }),
  );

  return baseServer;
}

function createClient(mcp) {
  return new mcp.Client({ name: "braintrust-e2e-client", version: "1.0.0" });
}

async function runHttpSession(mcp, decorateServer) {
  const server = createServer(mcp, decorateServer);
  const serverTransport = new mcp.WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(serverTransport);

  // Serve requests in-process so server spans share the client's trace.
  const client = createClient(mcp);
  await client.connect(
    new mcp.StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      fetch: (url, init) =>
        serverTransport.handleRequest(new Request(url, init)),
    }),
  );

  await client.callTool({ name: "get_weather", arguments: { city: "Vienna" } });
  await client.callTool({ name: "get_weather", arguments: { city: "Paris" } });
  await client.readResource({ uri: "notes://forecast" });
  await client.getPrompt({ name: "forecast", arguments: { city: "Vienna" } });

  await client.close();
  await server.close();
}

async function runInMemorySession(mcp, decorateServer) {
  const server = createServer(mcp, decorateServer);
  const [clientTransport, serverTransport] =
    mcp.InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = createClient(mcp);
  await client.connect(clientTransport);

  await client.callTool({
    name: "get_weather",
    arguments: { city: "Tokyo" },
    _meta: {
      "io.modelcontextprotocol/clientInfo": {
        name: "trace-client",
        version: "1.0.0",
        private: "omitted",
      },
      private: "omitted",
    },
  });
  await client.callTool({ name: "render_map", arguments: {} });
  await client.callTool({ name: "get_alerts", arguments: {} });

  await client.close();
  await server.close();
}

async function runLifecycleSession(mcp, decorateServer) {
  const server = createServer(mcp, decorateServer);
  let handlerStarted;
  let handlerCancelled;
  const started = new Promise((resolve) => {
    handlerStarted = resolve;
  });
  const cancelled = new Promise((resolve) => {
    handlerCancelled = resolve;
  });
  server.registerTool(
    "wait_for_cancel",
    { description: "Wait for cancellation", inputSchema: mcp.schema({}) },
    async (_args, extra) => {
      handlerStarted();
      const signal = extra.mcpReq?.signal ?? extra.signal;
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      handlerCancelled();
      return { content: [] };
    },
  );
  const [clientTransport, serverTransport] =
    mcp.InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = createClient(mcp);
  await client.connect(clientTransport);

  // Exercise actual protocol dispatch and validation with raw wire requests,
  // including requests rejected before a registered handler can run.
  const responses = new Map();
  clientTransport.onmessage = (message) => {
    responses.get(message.id)?.(message);
  };
  for (const request of [
    { id: 100, method: "ping" },
    { id: 101, method: "tools/list" },
    { id: 102, method: "acme/missing" },
    {
      id: 103,
      method: "tools/call",
      params: { name: "get_weather", arguments: { city: 42 } },
    },
  ]) {
    const response = new Promise((resolve) =>
      responses.set(request.id, resolve),
    );
    await clientTransport.send({ jsonrpc: "2.0", ...request });
    await response;
    responses.delete(request.id);
  }
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 104,
    method: "tools/call",
    params: { name: "wait_for_cancel", arguments: {} },
  });
  await started;
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 104, reason: "private cancellation reason" },
  });
  await cancelled;
  // Wait for the handler's settlement before closing its connection.
  await new Promise((resolve) => setImmediate(resolve));

  const fallbackStarted = new Promise((resolve) => {
    handlerStarted = resolve;
  });
  const fallbackCancelled = new Promise((resolve) => {
    handlerCancelled = resolve;
  });
  // Direct assignments after connect must receive the same lifecycle handling.
  server.server.fallbackRequestHandler = async (_request, extra) => {
    handlerStarted();
    const signal = extra.mcpReq?.signal ?? extra.signal;
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    handlerCancelled();
    return {};
  };
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 105,
    method: "acme/cancel",
  });
  await fallbackStarted;
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 105, reason: "private cancellation reason" },
  });
  await fallbackCancelled;
  await new Promise((resolve) => setImmediate(resolve));
  await client.close();
  await server.close();
}

export async function runMCPInstrumentationScenario(
  mcp,
  { decorateServer } = {},
) {
  await runTracedScenario({
    callback: async () => {
      await runOperation("mcp-http-session-operation", "http-session", () =>
        runHttpSession(mcp, decorateServer),
      );
      await runOperation(
        "mcp-in-memory-session-operation",
        "in-memory-session",
        () => runInMemorySession(mcp, decorateServer),
      );
      await runOperation("mcp-lifecycle-operation", "lifecycle", () =>
        runLifecycleSession(mcp, decorateServer),
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-mcp-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedMCPInstrumentation(mcp) {
  await runMCPInstrumentationScenario(mcp, { decorateServer: wrapMCPServer });
}

export async function runAutoMCPInstrumentation(mcp) {
  await runMCPInstrumentationScenario(mcp);
}
