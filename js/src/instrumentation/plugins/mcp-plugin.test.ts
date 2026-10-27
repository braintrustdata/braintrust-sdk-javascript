import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Attachment,
  _exportsForTestingOnly,
  initLogger,
  traced,
} from "../../logger";
import { configureNode } from "../../node/config";
import type {
  MCPProtocol,
  MCPRequest,
  MCPRequestHandler,
  MCPRequestHandlerExtra,
} from "../../vendor-sdk-types/mcp";
import {
  mcpChannels,
  mcpSDKChannels,
  mcpServerChannels,
} from "./mcp-interceptors";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function createProtocol(transport?: object): MCPProtocol {
  return {
    setRequestHandler: () => {},
    transport,
  };
}

function handleRequest(
  handler: MCPRequestHandler,
  request: MCPRequest,
  extra: MCPRequestHandlerExtra = {},
  protocol: MCPProtocol = createProtocol(),
): unknown {
  return mcpChannels.requestHandler.invoke(
    handler,
    undefined,
    [request, extra],
    { protocol },
  );
}

describe("MCPPlugin", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "mcp-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  async function drainSpans(): Promise<Record<string, any>[]> {
    return (await backgroundLogger.drain()) as Record<string, any>[];
  }

  it("traces tool calls with the transport session ID", async () => {
    const result = await handleRequest(
      async () => ({
        content: [{ type: "text", text: "sunny" }],
        structuredContent: { forecast: "sunny" },
        _meta: { "example/trace": "omitted" },
      }),
      {
        method: "tools/call",
        params: { name: "get_weather", arguments: { city: "Vienna" } },
      },
      { sessionId: "session-1", requestId: 7 },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "sunny" }],
      structuredContent: { forecast: "sunny" },
      _meta: { "example/trace": "omitted" },
    });

    const [span] = await drainSpans();
    expect(span.span_attributes).toMatchObject({
      name: "get_weather",
      type: "tool",
    });
    expect(span.input).toEqual({ city: "Vienna" });
    expect(span.output).toEqual({
      content: [{ type: "text", text: "sunny" }],
      structuredContent: { forecast: "sunny" },
    });
    expect(span.metadata).toEqual({
      "mcp.method": "tools/call",
      "mcp.request_id": 7,
      "mcp.session_id": "session-1",
    });
    expect(span.error).toBeUndefined();
  });

  it("synthesizes a stable session ID per transport", async () => {
    const firstConnection = createProtocol({});
    const secondConnection = createProtocol({});
    const request = { method: "tools/call", params: { name: "noop" } };
    const handler = async () => ({ content: [] });

    await handleRequest(
      handler,
      request,
      { mcpReq: { id: 1 } },
      firstConnection,
    );
    await handleRequest(
      handler,
      request,
      { mcpReq: { id: 2 } },
      firstConnection,
    );
    await handleRequest(
      handler,
      request,
      { mcpReq: { id: 1 } },
      secondConnection,
    );

    const spans = await drainSpans();
    const sessionIds = spans.map((span) => span.metadata["mcp.session_id"]);
    expect(spans.map((span) => span.metadata["mcp.request_id"])).toEqual([
      1, 2, 1,
    ]);
    expect(sessionIds[0]).toEqual(expect.any(String));
    expect(sessionIds[1]).toBe(sessionIds[0]);
    expect(sessionIds[2]).not.toBe(sessionIds[0]);
  });

  it("logs tool error results and thrown errors", async () => {
    await handleRequest(
      async () => ({
        content: [{ type: "text", text: "City not found" }],
        isError: true,
      }),
      { method: "tools/call", params: { name: "get_weather" } },
    );

    const failure = new Error("Tool missing not found");
    await expect(
      handleRequest(
        async () => {
          throw failure;
        },
        { method: "tools/call", params: { name: "missing" } },
      ),
    ).rejects.toBe(failure);

    const [errorResult, thrown] = await drainSpans();
    expect(errorResult.error).toBe("City not found");
    expect(errorResult.output).toEqual({
      content: [{ type: "text", text: "City not found" }],
      isError: true,
    });
    expect(thrown.span_attributes.name).toBe("missing");
    expect(thrown.error).toContain("Tool missing not found");
  });

  it("traces prompts and resources without dynamic span names", async () => {
    await handleRequest(
      async () => ({
        messages: [
          { role: "user", content: { type: "text", text: "Review this" } },
        ],
      }),
      {
        method: "prompts/get",
        params: { name: "review", arguments: { language: "ts" } },
      },
    );
    await handleRequest(
      async () => ({
        contents: [{ uri: "file:///notes.txt", text: "notes" }],
      }),
      { method: "resources/read", params: { uri: "file:///notes.txt" } },
    );

    const [prompt, resource] = await drainSpans();
    expect(prompt.span_attributes).toMatchObject({
      name: "prompts/get",
      type: "function",
    });
    expect(prompt.input).toEqual({ language: "ts" });
    expect(prompt.metadata).toMatchObject({
      "mcp.method": "prompts/get",
      "mcp.prompt_name": "review",
    });
    expect(resource.span_attributes).toMatchObject({
      name: "resources/read",
      type: "function",
    });
    expect(resource.input).toEqual({ uri: "file:///notes.txt" });
    expect(resource.metadata).toMatchObject({
      "mcp.method": "resources/read",
      "mcp.resource_uri": "file:///notes.txt",
    });
    expect(resource.output).toEqual({
      contents: [{ uri: "file:///notes.txt", text: "notes" }],
    });
  });

  it.each(["tools/list", "initialize", "constructor", "__proto__"])(
    "does not trace %s requests",
    async (method) => {
      const result = await handleRequest(async () => ({ ok: true }), {
        method,
      });

      expect(result).toEqual({ ok: true });
      expect(await drainSpans()).toEqual([]);
    },
  );

  it("nests spans created by handlers under the request span", async () => {
    await handleRequest(
      async () =>
        traced(async () => ({ content: [] }), { name: "tool-internals" }),
      { method: "tools/call", params: { name: "lookup" } },
    );

    const spans = await drainSpans();
    const tool = spans.find((span) => span.span_attributes.name === "lookup");
    const child = spans.find(
      (span) => span.span_attributes.name === "tool-internals",
    );
    expect(child?.span_parents).toEqual([tool?.span_id]);
  });

  it("omits inline media unless attachment capture is enabled", async () => {
    const result = {
      content: [
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        { type: "audio", data: PNG_BASE64, mimeType: "audio/wav" },
        {
          type: "resource",
          resource: {
            uri: "file:///pixel.png",
            blob: PNG_BASE64,
            mimeType: "image/png",
          },
        },
      ],
    };
    const request = { method: "tools/call", params: { name: "render" } };

    await handleRequest(async () => result, request);
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "1");
    await handleRequest(async () => result, request);

    const [disabled, enabled] = await drainSpans();
    expect(disabled.output.content).toEqual([
      { type: "image", data: "<omitted>", mimeType: "image/png" },
      { type: "audio", data: "<omitted>", mimeType: "audio/wav" },
      {
        type: "resource",
        resource: {
          uri: "file:///pixel.png",
          blob: "<omitted>",
          mimeType: "image/png",
        },
      },
    ]);
    expect(enabled.output.content[0].data).toBeInstanceOf(Attachment);
    expect(enabled.output.content[1].data).toBe("<omitted>");
    expect(enabled.output.content[2].resource.blob).toBeInstanceOf(Attachment);
    expect(result.content[0].data).toBe(PNG_BASE64);
  });

  it.each([
    ["v1", mcpSDKChannels.setRequestHandler],
    ["v2", mcpServerChannels.setRequestHandler],
  ])(
    "wraps handlers registered through %s setRequestHandler",
    async (_, hook) => {
      const handlers = new Map<string, MCPRequestHandler>();
      const protocol: MCPProtocol = {
        setRequestHandler(method: unknown, handler: unknown) {
          handlers.set(method as string, handler as MCPRequestHandler);
        },
      };

      hook.invoke(
        protocol.setRequestHandler,
        protocol,
        ["tools/call", async () => ({ content: [] })],
        {},
      );
      // v2 re-invokes the handler with the same context for input-required rounds.
      const extra = { sessionId: "session-2" };
      const request = { method: "tools/call", params: { name: "registered" } };
      await handlers.get("tools/call")!(request, extra);
      await handlers.get("tools/call")!(request, extra);

      const spans = await drainSpans();
      expect(spans.map((span) => span.span_attributes.name)).toEqual([
        "registered",
        "registered",
      ]);
      expect(spans[0].metadata["mcp.session_id"]).toBe("session-2");
    },
  );

  it("leaves custom v2 handlers registered with schemas untouched", () => {
    const schemas = { params: {} };
    const handler = async () => ({});
    const setRequestHandler = vi.fn();

    mcpServerChannels.setRequestHandler.invoke(
      setRequestHandler,
      createProtocol(),
      ["acme/search", schemas, handler],
      {},
    );

    expect(setRequestHandler).toHaveBeenCalledWith(
      "acme/search",
      schemas,
      handler,
    );
  });
});
