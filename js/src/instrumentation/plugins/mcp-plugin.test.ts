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
  withParent,
} from "../../logger";
import { registry } from "../registry";
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
    connect: () => {},
    setRequestHandler: () => {},
    transport: Object.assign(transport ?? {}, { start() {}, send() {} }),
  };
}

function handleRequest(
  handler: MCPRequestHandler,
  request: MCPRequest,
  extra: MCPRequestHandlerExtra = {},
  protocol: MCPProtocol = createProtocol(),
): unknown {
  const transport = protocol.transport!;
  transport.sessionId = extra.sessionId;
  const id = extra.mcpReq?.id ?? extra.requestId ?? request.id ?? 0;
  return mcpChannels.message.invoke(
    async () => {
      const result = await mcpChannels.requestHandler.invoke(
        handler,
        undefined,
        [request, { ...extra, requestId: id }],
        { protocol },
      );
      if (!extra.signal?.aborted && !extra.mcpReq?.signal?.aborted) {
        await mcpChannels.send.invoke(
          transport.send,
          transport,
          [{ jsonrpc: "2.0", id, result }],
          { transport },
        );
      }
      return result;
    },
    transport,
    [{ ...request, id }],
    { transport },
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
    registry.disable();
    registry.configure({ integrations: { mcp: { captureContent: true } } });
    registry.enable();
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
      name: "tools/call get_weather",
      type: "tool",
    });
    expect(span.input).toEqual({ city: "Vienna" });
    expect(span.output).toEqual({
      content: [{ type: "text", text: "sunny" }],
      structuredContent: { forecast: "sunny" },
    });
    expect(span.metadata).toEqual({
      "mcp.method.name": "tools/call",
      "jsonrpc.request.id": "7",
      "gen_ai.tool.name": "get_weather",
      "gen_ai.operation.name": "execute_tool",
      "mcp.session.id": "session-1",
    });
    expect(span.error).toBeUndefined();
  });

  it("omits session IDs when no MCP session exists", async () => {
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
    const sessionIds = spans.map((span) => span.metadata["mcp.session.id"]);
    expect(spans.map((span) => span.metadata["jsonrpc.request.id"])).toEqual([
      "1",
      "2",
      "1",
    ]);
    expect(sessionIds).toEqual([undefined, undefined, undefined]);
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
    expect(thrown.span_attributes.name).toBe("tools/call missing");
    expect(thrown.error).toContain("Tool missing not found");
  });

  it("names prompts by target and keeps resource URIs out of names", async () => {
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
      name: "prompts/get review",
      type: "function",
    });
    expect(prompt.input).toEqual({ language: "ts" });
    expect(prompt.metadata).toMatchObject({
      "mcp.method.name": "prompts/get",
      "gen_ai.prompt.name": "review",
    });
    expect(resource.span_attributes).toMatchObject({
      name: "resources/read",
      type: "function",
    });
    expect(resource.input).toEqual({ uri: "file:///notes.txt" });
    expect(resource.metadata).toMatchObject({
      "mcp.method.name": "resources/read",
      "mcp.resource.uri": "file:///notes.txt",
    });
    expect(resource.output).toEqual({
      contents: [{ uri: "file:///notes.txt", text: "notes" }],
    });
  });

  it.each(["tools/list", "initialize", "constructor", "__proto__"])(
    "traces %s without capturing arbitrary payloads",
    async (method) => {
      const result = await handleRequest(async () => ({ ok: true }), {
        method,
      });

      expect(result).toEqual({ ok: true });
      const [span] = await drainSpans();
      expect(span.span_attributes).toMatchObject({
        name: method,
        type: "function",
      });
      expect(span.input).toBeUndefined();
      expect(span.output).toBeUndefined();
    },
  );

  it("nests spans created by handlers under the request span", async () => {
    await handleRequest(
      async () =>
        traced(async () => ({ content: [] }), { name: "tool-internals" }),
      { method: "tools/call", params: { name: "lookup" } },
    );

    const spans = await drainSpans();
    const tool = spans.find(
      (span) => span.span_attributes.name === "tools/call lookup",
    );
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
        ...createProtocol(),
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
      await handleRequest(
        handlers.get("tools/call")!,
        request,
        extra,
        protocol,
      );
      await handleRequest(
        handlers.get("tools/call")!,
        request,
        extra,
        protocol,
      );

      const spans = await drainSpans();
      expect(spans.map((span) => span.span_attributes.name)).toEqual([
        "tools/call registered",
        "tools/call registered",
      ]);
      expect(spans[0].metadata["mcp.session.id"]).toBe("session-2");
    },
  );

  it("wraps custom v2 handlers without changing their schemas", () => {
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
      expect.any(Function),
    );
  });
  it("keeps a request open through asynchronous response sending", async () => {
    let completeSend!: () => void;
    const sent = new Promise<void>((resolve) => {
      completeSend = resolve;
    });
    const protocol = createProtocol();
    protocol.transport!.send = () => sent;
    const result = handleRequest(
      async () => ({ content: [] }),
      { method: "tools/call", params: { name: "slow-send" } },
      {},
      protocol,
    );
    await Promise.resolve();
    const [started] = await drainSpans();
    expect(started.metrics.end).toBeUndefined();
    completeSend();
    await result;
    const [ended] = await drainSpans();
    expect(ended.metrics.end).toEqual(expect.any(Number));
  });

  it("captures validation errors without a handler and omits error data", async () => {
    const transport = createProtocol().transport!;
    await mcpChannels.message.invoke(
      () =>
        mcpChannels.send.invoke(
          transport.send,
          transport,
          [
            {
              id: 0,
              error: {
                code: -32602,
                message: "Invalid arguments",
                data: { secret: "hidden" },
              },
            },
          ],
          { transport },
        ),
      transport,
      [{ id: 0, method: "tools/call", params: { name: "invalid" } }],
      { transport },
    );
    const [span] = await drainSpans();
    expect(span.error).toBeUndefined();
    expect(span.metadata["error.type"]).toBeUndefined();
    expect(span.metadata["rpc.response.status_code"]).toBe("-32602");
    expect(span.input).toBeUndefined();
    expect(span.output).toBeUndefined();
    expect(span.metadata["jsonrpc.request.id"]).toBe("0");
  });

  it("propagates response-send failures and ends the span", async () => {
    const protocol = createProtocol();
    const failure = new Error("send failed");
    protocol.transport!.send = () => Promise.reject(failure);
    await expect(
      handleRequest(
        async () => ({ content: [] }),
        { method: "tools/call" },
        {},
        protocol,
      ),
    ).rejects.toBe(failure);
    const [span] = await drainSpans();
    expect(span.error).toContain("send failed");
    expect(span.metrics.end).toEqual(expect.any(Number));
  });

  it.each(["v1", "v2"])(
    "ends %s cancellation after processing without an error",
    async (version) => {
      const controller = new AbortController();
      let complete!: () => void;
      const waiting = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const protocol = createProtocol();
      const extra =
        version === "v1"
          ? { signal: controller.signal }
          : { mcpReq: { id: 0, signal: controller.signal } };
      const result = handleRequest(
        async () => {
          await waiting;
          throw new Error("arbitrary cancellation exception");
        },
        { method: "tools/call" },
        extra,
        protocol,
      );
      controller.abort();
      const [started] = await drainSpans();
      expect(started.metrics.end).toBeUndefined();
      complete();
      await expect(result).rejects.toThrow("arbitrary cancellation exception");
      const [ended] = await drainSpans();
      expect(ended.metadata["mcp.cancelled"]).toBe(true);
      expect(ended.error).toBeUndefined();
      expect(ended.metrics.end).toEqual(expect.any(Number));
      mcpChannels.send.invoke(
        protocol.transport!.send,
        protocol.transport,
        [{ id: 0, result: { content: [] } }],
        { transport: protocol.transport! },
      );
      expect(await drainSpans()).toEqual([]);
    },
  );

  it("does not mistake an error message for cancellation", async () => {
    await expect(
      handleRequest(
        async () => {
          throw new Error("request cancelled by upstream");
        },
        { method: "tools/call" },
      ),
    ).rejects.toThrow();
    const [span] = await drainSpans();
    expect(span.error).toContain("cancelled by upstream");
    expect(span.metadata["mcp.cancelled"]).toBeUndefined();
  });

  it("ends pending requests once on connection closure, ignoring late responses", async () => {
    const transport = createProtocol().transport!;
    mcpChannels.message.invoke(
      () => {},
      transport,
      [{ id: 1, method: "ping" }],
      { transport },
    );
    mcpChannels.close.invoke(() => {}, transport, [], { transport });
    mcpChannels.close.invoke(() => {}, transport, [], { transport });
    mcpChannels.send.invoke(
      transport.send,
      transport,
      [{ id: 1, result: {} }],
      { transport },
    );
    const [span] = await drainSpans();
    expect(span.error).toContain("connection closed");
    expect(span.output).toBeUndefined();
    expect(span.metrics.end).toEqual(expect.any(Number));
  });

  it("keeps numeric and string IDs separate and permits ID reuse after completion", async () => {
    const protocol = createProtocol();
    const transports = [protocol.transport!, createProtocol().transport!];
    for (const transport of transports) {
      for (const id of [0, "0"]) {
        mcpChannels.message.invoke(
          () => {},
          transport,
          [{ id, method: "ping" }],
          { transport },
        );
      }
      for (const id of [0, "0"]) {
        mcpChannels.send.invoke(
          transport.send,
          transport,
          [{ id, result: {} }],
          { transport },
        );
      }
    }
    await handleRequest(
      async () => ({}),
      { method: "ping", id: 0 },
      {},
      protocol,
    );
    const spans = await drainSpans();
    expect(spans).toHaveLength(5);
    expect(new Set(spans.map((span) => span.span_id)).size).toBe(5);
    expect(spans.map((span) => span.metadata["jsonrpc.request.id"])).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(spans.every((span) => typeof span.metrics.end === "number")).toBe(
      true,
    );
  });

  it("translates allowlisted metadata and preserves application _meta", async () => {
    const result = {
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "weather",
          title: "Weather",
          version: "1",
          secret: "hidden",
        },
        traceparent: "ignored",
      },
      structuredContent: { _meta: { app: "preserved" } },
      content: [
        { type: "text", text: "sunny", _meta: { token: "hidden" } },
        {
          type: "resource",
          resource: {
            uri: "notes://forecast",
            text: "notes",
            _meta: { private: true },
          },
        },
      ],
    };
    const args = { _meta: { application: true } };
    expect(
      await handleRequest(async () => result, {
        method: "tools/call",
        params: {
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2025-11-25",
            "io.modelcontextprotocol/clientInfo": {
              name: "client",
              title: 12,
              version: "2",
              secret: "hidden",
            },
            "io.modelcontextprotocol/capabilities": { secret: true },
            baggage: "private=value",
          },
        },
      }),
    ).toBe(result);
    const [span] = await drainSpans();
    expect(span.input).toEqual(args);
    expect(span.metadata).toMatchObject({
      "mcp.protocol.version": "2025-11-25",
      "mcp.client.name": "client",
      "mcp.client.version": "2",
      "mcp.server.name": "weather",
      "mcp.server.title": "Weather",
      "mcp.server.version": "1",
    });
    expect(span.metadata["mcp.client.title"]).toBeUndefined();
    expect(span.output.structuredContent).toEqual(result.structuredContent);
    expect(span.output._meta).toBeUndefined();
    expect(span.output.content[0]._meta).toBeUndefined();
    expect(span.output.content[1].resource._meta).toBeUndefined();
    expect(JSON.stringify(span)).not.toContain("hidden");
    expect(JSON.stringify(span)).not.toContain("private=value");
    expect(result.content[0]._meta).toEqual({ token: "hidden" });
  });

  it("uses incoming trace identity and routing instead of the active parent", async () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    const parentId = "0123456789abcdef";
    await traced(
      async () =>
        handleRequest(
          async () => ({
            content: [],
            _meta: {
              traceparent:
                "00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01",
            },
          }),
          {
            method: "tools/call",
            params: {
              _meta: {
                traceparent: `00-${traceId}-${parentId}-01`,
                baggage: "braintrust.parent=project_id:remote-project",
              },
            },
          },
        ),
      { name: "local-parent" },
    );
    const span = (await drainSpans()).find(
      (span) => span.span_attributes.name === "tools/call",
    )!;
    expect(span.root_span_id).toBe(traceId);
    expect(span.span_parents).toEqual([parentId]);
    expect(span.project_id).toBe("remote-project");
    expect(JSON.stringify(span.output)).not.toContain("traceparent");
  });

  it.each([undefined, "invalid"])(
    "starts a new trace for MCP context %s despite an active parent",
    async (traceparent) => {
      await traced(
        async () =>
          handleRequest(async () => ({ content: [] }), {
            method: "tools/call",
            params: { _meta: { traceparent } },
          }),
        { name: "parent" },
      );
      const spans = await drainSpans();
      const parent = spans.find(
        (span) => span.span_attributes.name === "parent",
      )!;
      const child = spans.find(
        (span) => span.span_attributes.name === "tools/call",
      )!;
      expect(child.span_parents ?? []).toEqual([]);
      expect(child.root_span_id).not.toBe(parent.root_span_id);
      expect(child.root_span_id).toMatch(/^[0-9a-f]{32}$/);
    },
  );

  it("starts a new trace without MCP context despite withParent context", async () => {
    await traced(
      async (parent) => {
        await withParent(await parent.export(), () =>
          handleRequest(async () => ({}), { method: "ping" }),
        );
      },
      { name: "parent" },
    );
    const spans = await drainSpans();
    const parent = spans.find(
      (span) => span.span_attributes.name === "parent",
    )!;
    const child = spans.find((span) => span.span_attributes.name === "ping")!;
    expect(child.span_parents ?? []).toEqual([]);
    expect(child.root_span_id).not.toBe(parent.root_span_id);
    expect(child.root_span_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("traces notifications but excludes responses and detached tasks", async () => {
    const transport = createProtocol().transport!;
    for (const message of [
      {
        method: "notifications/cancelled",
        params: { requestId: 100, reason: "hidden" },
      },
      { id: 100, result: {} },
      { id: 100, method: "tasks/get" },
      { id: 100, method: "tools/call", params: { task: { ttl: 1000 } } },
      {
        id: 100,
        method: "tools/call",
        params: {
          _meta: { "io.modelcontextprotocol/related-task": { taskId: "1" } },
        },
      },
    ]) {
      mcpChannels.message.invoke(() => {}, transport, [message], { transport });
    }
    await Promise.resolve();
    const [span] = await drainSpans();
    expect(span.span_attributes.name).toBe("notifications/cancelled");
    expect(span.metadata["jsonrpc.request.id"]).toBeUndefined();
    expect(span.metadata["mcp.cancelled"]).toBeUndefined();
    expect(span.metrics.end).toEqual(expect.any(Number));
    expect(JSON.stringify(span)).not.toContain("hidden");
  });

  it("retains sanitized results if attachment conversion fails", async () => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
    await handleRequest(
      async () => ({
        _meta: { secret: true },
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "not base64!",
            _meta: { secret: true },
          },
        ],
      }),
      { method: "tools/call" },
    );
    const [span] = await drainSpans();
    expect(span.output).toEqual({
      content: [{ type: "image", mimeType: "image/png", data: "not base64!" }],
    });
  });
  it("keeps concurrent handler contexts independent across awaits", async () => {
    const protocol = createProtocol();
    await Promise.all(
      ["first", "second"].map((name, id) =>
        handleRequest(
          async () => {
            await Promise.resolve();
            return traced(async () => ({ content: [] }), {
              name: `${name}-child`,
            });
          },
          { id, method: "tools/call", params: { name } },
          {},
          protocol,
        ),
      ),
    );
    const spans = await drainSpans();
    for (const name of ["first", "second"]) {
      const parent = spans.find(
        (span) => span.span_attributes.name === `tools/call ${name}`,
      )!;
      const child = spans.find(
        (span) => span.span_attributes.name === `${name}-child`,
      )!;
      expect(child.span_parents).toEqual([parent.span_id]);
    }
  });

  it("does not let a cancelled request's late response finish a reused ID", async () => {
    const protocol = createProtocol();
    const transport = protocol.transport!;
    const controller = new AbortController();
    let sendLate!: () => unknown;
    await handleRequest(
      async () => {
        // Retain the original request's asynchronous context.
        const late = new Promise<void>((resolve) => {
          sendLate = resolve;
        });
        void late.then(() =>
          mcpChannels.send.invoke(
            transport.send,
            transport,
            [{ id: 0, result: { content: [{ type: "text", text: "late" }] } }],
            { transport },
          ),
        );
        controller.abort();
        return { content: [] };
      },
      { method: "tools/call" },
      { signal: controller.signal },
      protocol,
    );
    await drainSpans();
    mcpChannels.message.invoke(
      () => {},
      transport,
      [{ id: 0, method: "ping" }],
      { transport },
    );
    sendLate();
    await Promise.resolve();
    const [pending] = await drainSpans();
    expect(pending.span_attributes.name).toBe("ping");
    expect(pending.metrics.end).toBeUndefined();
    mcpChannels.send.invoke(
      transport.send,
      transport,
      [{ id: 0, result: {} }],
      { transport },
    );
    const [ended] = await drainSpans();
    expect(ended.metrics.end).toEqual(expect.any(Number));
  });

  it("preserves a failure observed before cancellation", async () => {
    const protocol = createProtocol();
    const transport = protocol.transport!;
    const controller = new AbortController();
    await mcpChannels.message.invoke(
      async () => {
        await Promise.resolve(
          mcpChannels.requestHandler.invoke(
            async () => {
              throw new Error("independent failure");
            },
            undefined,
            [
              { method: "tools/call" },
              { requestId: 0, signal: controller.signal },
            ],
            { protocol },
          ),
        ).catch(() => {});
        controller.abort();
        await mcpChannels.requestHandler.invoke(
          async () => ({}),
          undefined,
          [
            { method: "tools/call" },
            { requestId: 0, signal: controller.signal },
          ],
          { protocol },
        );
      },
      transport,
      [{ id: 0, method: "tools/call" }],
      { transport },
    );
    const [span] = await drainSpans();
    expect(span.metadata["mcp.cancelled"]).toBe(true);
    expect(span.error).toContain("independent failure");
  });

  it("captures arguments, results, and tool error text by default", async () => {
    registry.disable();
    registry.configure({ integrations: { mcp: true } });
    registry.enable();
    await handleRequest(
      async () => ({
        content: [{ type: "text", text: "City not found" }],
        isError: true,
      }),
      {
        method: "tools/call",
        params: { name: "lookup", arguments: { city: "Atlantis" } },
      },
    );
    const [span] = await drainSpans();
    expect(span.input).toEqual({ city: "Atlantis" });
    expect(span.output).toEqual({
      content: [{ type: "text", text: "City not found" }],
      isError: true,
    });
    expect(span.error).toBe("City not found");
  });

  it("does not capture arguments, results, or tool error text when captureContent is false", async () => {
    registry.disable();
    registry.configure({ integrations: { mcp: { captureContent: false } } });
    registry.enable();
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
    const result = {
      content: [{ type: "text", text: "private error text" }],
      isError: true,
    };
    const returned = await handleRequest(async () => result, {
      method: "tools/call",
      params: { name: "lookup", arguments: { secret: "private argument" } },
    });
    expect(returned).toBe(result);
    const [span] = await drainSpans();
    expect(span.input).toBeUndefined();
    expect(span.output).toBeUndefined();
    expect(span.error).toBe("Tool returned an error result");
    expect(span.metadata["error.type"]).toBe("tool_error");
    expect(span.metadata["rpc.response.status_code"]).toBeUndefined();
    expect(JSON.stringify(span)).not.toContain("private");
  });

  it.each([-32700, -32600, -32601, -32602, -32002, -32603, -32000])(
    "classifies the final JSON-RPC response %s instead of a caught handler exception",
    async (code) => {
      const protocol = createProtocol();
      const transport = protocol.transport!;
      await mcpChannels.message.invoke(
        async () => {
          await Promise.resolve(
            mcpChannels.requestHandler.invoke(
              async () => {
                throw new TypeError("caught validation exception");
              },
              undefined,
              [{ method: "tools/call" }, { requestId: 0 }],
              { protocol },
            ),
          ).catch(() => {});
          mcpChannels.send.invoke(
            transport.send,
            transport,
            [
              {
                id: 0,
                error: {
                  code,
                  message: "protocol failure",
                  data: "private data",
                },
              },
            ],
            { transport },
          );
        },
        transport,
        [{ id: 0, method: "tools/call" }],
        { transport },
      );
      const [span] = await drainSpans();
      expect(span.metadata["rpc.response.status_code"]).toBe(String(code));
      if ([-32603, -32000].includes(code)) {
        expect(span.error).toContain("protocol failure");
        expect(span.metadata["error.type"]).toBe(String(code));
      } else {
        expect(span.error).toBeUndefined();
        expect(span.metadata["error.type"]).toBeUndefined();
      }
      expect(JSON.stringify(span)).not.toContain("caught validation exception");
      expect(JSON.stringify(span)).not.toContain("private data");
      expect(span.metrics.end).toEqual(expect.any(Number));
    },
  );

  it("keeps notification processing and transport acknowledgement in the span lifetime", async () => {
    const protocol = createProtocol();
    const transport = protocol.transport!;
    let completeHandler!: () => void;
    let acknowledge!: () => void;
    const processing = new Promise<void>((resolve) => {
      completeHandler = resolve;
    });
    const ack = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const result = mcpChannels.message.invoke(
      () => {
        void Promise.resolve().then(() =>
          mcpChannels.notificationHandler.invoke(
            async () => {
              await processing;
              await traced(async () => {}, {
                name: "nested-notification-work",
              });
            },
            undefined,
            [{ method: "notifications/resources/updated" }],
            { protocol },
          ),
        );
        return ack;
      },
      transport,
      [
        {
          method: "notifications/resources/updated",
          params: { uri: "notes://updated", secret: "private" },
        },
      ],
      { transport },
    );
    expect(result).toBe(ack);
    await Promise.resolve();
    const [started] = await drainSpans();
    expect(started.metrics.end).toBeUndefined();
    completeHandler();
    await new Promise((resolve) => setImmediate(resolve));
    const interim = await drainSpans();
    const nested = interim.find(
      (span) => span.span_attributes.name === "nested-notification-work",
    )!;
    expect(nested.span_parents).toEqual([started.span_id]);
    expect(
      interim.find((span) => span.span_id === started.span_id)?.metrics?.end,
    ).toBeUndefined();
    acknowledge();
    await result;
    await Promise.resolve();
    const [ended] = await drainSpans();
    expect(ended.metrics.end).toEqual(expect.any(Number));
    expect(started.metadata["mcp.resource.uri"]).toBe("notes://updated");
    expect(started.metadata["jsonrpc.request.id"]).toBeUndefined();
    expect(started.input).toMatchObject({
      uri: "notes://updated",
      secret: "private",
    });
    expect(JSON.stringify(started.input)).not.toContain("traceparent");
  });

  it("waits for HTTP acknowledgement after an asynchronous notification handler", async () => {
    const protocol = createProtocol();
    const transport = protocol.transport!;
    let acknowledge!: () => void;
    const ack = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const result = mcpChannels.httpRequest.invoke(
      () => {
        mcpChannels.message.invoke(
          () => {
            void Promise.resolve().then(() =>
              mcpChannels.notificationHandler.invoke(
                async () => {
                  await Promise.resolve();
                },
                undefined,
                [{ method: "acme/notice" }],
                { protocol },
              ),
            );
          },
          transport,
          [{ method: "acme/notice" }],
          { transport },
        );
        return ack;
      },
      transport,
      [{ httpVersion: "1.1" }],
      { transport },
    );
    expect(result).toBe(ack);
    await new Promise((resolve) => setImmediate(resolve));
    const [started] = await drainSpans();
    expect(started.metrics.end).toBeUndefined();
    acknowledge();
    await result;
    const [ended] = await drainSpans();
    expect(ended.metrics.end).toEqual(expect.any(Number));
  });

  it("records notification failure without changing the handler promise", async () => {
    const protocol = createProtocol();
    const transport = protocol.transport!;
    const error = new TypeError("notification failed");
    let task!: Promise<unknown>;
    mcpChannels.message.invoke(
      () => {
        task = Promise.resolve().then(() =>
          mcpChannels.notificationHandler.invoke(
            () => Promise.reject(error),
            undefined,
            [{ method: "acme/notice" }],
            { protocol },
          ),
        );
      },
      transport,
      [{ method: "acme/notice" }],
      { transport },
    );
    await expect(task).rejects.toBe(error);
    const [span] = await drainSpans();
    expect(span.error).toContain("notification failed");
    expect(span.metadata["error.type"]).toBe("TypeError");
    expect(span.metrics.end).toEqual(expect.any(Number));
  });

  it("traces outgoing notifications with their related request and send lifetime", async () => {
    const protocol = createProtocol();
    const transport = protocol.transport!;
    let resolveSend!: () => void;
    const send = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    let notification!: Promise<void>;
    const request = mcpChannels.message.invoke(
      () => {
        notification = mcpChannels.send.invoke(
          () => send,
          transport,
          [
            {
              method: "notifications/progress",
              params: {
                progressToken: 0,
                progress: 1,
                total: 2,
                message: "working",
              },
            },
            { relatedRequestId: 0 },
          ],
          { transport },
        ) as Promise<void>;
      },
      transport,
      [{ id: 0, method: "tools/call", params: { name: "example" } }],
      { transport },
    );
    await request;
    resolveSend();
    await notification;
    await mcpChannels.send.invoke(
      () => Promise.resolve(),
      transport,
      [{ id: 0, result: {} }],
      { transport },
    );
    const spans = await drainSpans();
    const parent = spans.find(
      (span) => span.span_attributes.name === "tools/call example",
    )!;
    const child = spans.find(
      (span) => span.span_attributes.name === "notifications/progress",
    )!;
    expect(child.span_parents).toEqual([parent.span_id]);
    expect(child.metadata).toMatchObject({
      "mcp.notification.direction": "outgoing",
      "mcp.progress.token": "0",
      "mcp.progress.percentage": 50,
      "mcp.progress.message": "working",
    });
    expect(child.metrics.end).toEqual(expect.any(Number));
  });

  it("records outgoing send errors without changing the rejection", async () => {
    const transport = createProtocol().transport!;
    const error = new TypeError("send failed");
    await expect(
      mcpChannels.send.invoke(
        () => Promise.reject(error),
        transport,
        [{ method: "notifications/message", params: { level: "error" } }],
        { transport },
      ),
    ).rejects.toBe(error);
    const [span] = await drainSpans();
    expect(span.error).toContain("send failed");
    expect(span.metadata["error.type"]).toBe("TypeError");
  });

  it("captures legacy initialization identity for a stateful session", async () => {
    const protocol = createProtocol();
    await handleRequest(
      async () => ({
        protocolVersion: "2025-11-25",
        serverInfo: { name: "server", version: "2" },
      }),
      {
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          clientInfo: { name: "client", version: "1" },
        },
      },
      { sessionId: "session" },
      protocol,
    );
    await handleRequest(
      async () => ({}),
      {
        method: "tools/call",
        params: { name: "tool", tool_call_id: "call-1" },
      },
      { sessionId: "session" },
      protocol,
    );
    const spans = await drainSpans();
    expect(spans[0].metadata).toMatchObject({
      "mcp.client.name": "client",
      "mcp.server.name": "server",
    });
    expect(spans[1].metadata).toMatchObject({
      "mcp.client.name": "client",
      "mcp.server.name": "server",
      "gen_ai.tool.call.id": "call-1",
    });
  });

  it("retains initialization identity on sessionless connections", async () => {
    const protocol = createProtocol();
    await handleRequest(
      async () => ({ protocolVersion: "1", serverInfo: { name: "server" } }),
      { method: "initialize", params: { clientInfo: { name: "client" } } },
      {},
      protocol,
    );
    await handleRequest(async () => ({}), { method: "ping" }, {}, protocol);
    const spans = await drainSpans();
    expect(spans[1].metadata).toMatchObject({
      "mcp.client.name": "client",
      "mcp.server.name": "server",
    });
    expect(spans[1].metadata["mcp.session.id"]).toBeUndefined();
  });

  it("does not carry identity between sessionless HTTP requests", async () => {
    const protocol = createProtocol({ handleRequest() {} });
    await handleRequest(
      async () => ({ protocolVersion: "1", serverInfo: { name: "server" } }),
      { method: "initialize", params: { clientInfo: { name: "client" } } },
      {},
      protocol,
    );
    await handleRequest(async () => ({}), { method: "ping" }, {}, protocol);
    const spans = await drainSpans();
    expect(spans[1].metadata["mcp.client.name"]).toBeUndefined();
    expect(spans[1].metadata["mcp.server.name"]).toBeUndefined();
  });

  it("does not capture notification content when disabled", async () => {
    registry.disable();
    registry.configure({ integrations: { mcp: { captureContent: false } } });
    registry.enable();
    const transport = createProtocol().transport!;
    await mcpChannels.send.invoke(
      () => Promise.resolve(),
      transport,
      [
        {
          method: "notifications/message",
          params: { level: "info", data: "private" },
        },
      ],
      { transport },
    );
    const [span] = await drainSpans();
    expect(span.metadata).toMatchObject({
      "mcp.logging.level": "info",
      "mcp.logging.data_type": "string",
    });
    expect(JSON.stringify(span)).not.toContain("private");
  });

  it("does not carry initialization identity into an unrelated session", async () => {
    const protocol = createProtocol();
    await handleRequest(
      async () => ({ protocolVersion: "1", serverInfo: { name: "server" } }),
      { method: "initialize", params: { clientInfo: { name: "client" } } },
      { sessionId: "first" },
      protocol,
    );
    await handleRequest(
      async () => ({}),
      { method: "ping" },
      { sessionId: "second" },
      protocol,
    );
    const spans = await drainSpans();
    expect(spans[1].metadata["mcp.client.name"]).toBeUndefined();
    expect(spans[1].metadata["mcp.server.name"]).toBeUndefined();
  });

  it("ends pending spans on transport error and forwards the callback", async () => {
    const transport = createProtocol().transport!;
    const error = new TypeError("transport failed");
    await mcpChannels.message.invoke(
      () => {},
      transport,
      [{ id: 1, method: "ping" }],
      { transport },
    );
    const callback = vi.fn();
    mcpChannels.transportError.invoke(callback, transport, [error], {
      transport,
    });
    expect(callback).toHaveBeenCalledWith(error);
    const [span] = await drainSpans();
    expect(span.error).toContain("transport failed");
    expect(span.metadata["error.type"]).toBe("TypeError");
  });

  it("records only known HTTP transport and client fields", async () => {
    const protocol = createProtocol();
    const transport = protocol.transport!;
    await mcpChannels.httpRequest.invoke(
      () =>
        handleRequest(
          async () => ({}),
          {
            method: "resources/subscribe",
            params: { uri: "notes://forecast" },
          },
          {},
          protocol,
        ),
      transport,
      [
        {
          httpVersion: "2",
          socket: { remoteAddress: "127.0.0.1", remotePort: 4321 },
          headers: { authorization: "private" },
        },
      ],
      { transport },
    );
    const [span] = await drainSpans();
    expect(span.metadata).toMatchObject({
      "network.transport": "tcp",
      "network.protocol.name": "http",
      "network.protocol.version": "2",
      "client.address": "127.0.0.1",
      "client.port": 4321,
      "mcp.resource.uri": "notes://forecast",
    });
    expect(span.input).toBeUndefined();
    expect(JSON.stringify(span)).not.toContain("private");
  });

  it("uses the negotiated protocol version on subsequent operations", async () => {
    const protocol = createProtocol();
    await handleRequest(
      async () => ({ protocolVersion: "2025-11-25" }),
      { method: "initialize" },
      {},
      protocol,
    );
    await handleRequest(
      async () => ({}),
      {
        method: "ping",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      },
      {},
      protocol,
    );
    await handleRequest(async () => ({}), { method: "ping" }, {}, protocol);
    const spans = await drainSpans();
    expect(spans.map((span) => span.metadata["mcp.protocol.version"])).toEqual([
      "2025-11-25",
      "2026-07-28",
      "2025-11-25",
    ]);
  });

  it("does not instrument client transports", () => {
    const protocol = createProtocol();
    const transport = protocol.transport!;
    const send = transport.send;
    mcpSDKChannels.connect.invoke(protocol.connect, protocol, [transport], {});
    expect(transport.send).toBe(send);
  });
});
