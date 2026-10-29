import { debugLogger } from "../debug-logger";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { _exportsForTestingOnly, initLogger } from "../logger";
import { configureNode } from "../node/config";
import { mcpSDKChannels } from "../instrumentation/plugins/mcp-interceptors";
import type {
  MCPProtocol,
  MCPRequestHandler,
  MCPTransport,
  MCPRequest,
} from "../vendor-sdk-types/mcp";
import { wrapMCPServer } from "./mcp";
import { wrapMCPHandler } from "./mcp-handler";
import { registry } from "../instrumentation/registry";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

class FakeProtocol implements MCPProtocol {
  _requestHandlers = new Map<string, MCPRequestHandler>();
  transport?: MCPTransport;
  async connect(transport: MCPTransport) {
    this.transport = transport;
    transport.onmessage = async (message) => {
      const request = message as MCPRequest;
      const result = await this._requestHandlers.get(request.method)!(request, {
        requestId: request.id,
      });
      await transport.send({ jsonrpc: "2.0", id: request.id, result });
    };
    transport.onclose = () => {};
    await transport.start();
  }

  setRequestHandler(method: unknown, handler: unknown): void {
    this._requestHandlers.set(method as string, handler as MCPRequestHandler);
  }

  handle(method: string, params: Record<string, unknown> = {}) {
    return this.transport!.onmessage!({ id: 0, method, params });
  }
}

describe("MCP server wrapper", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "mcp.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  async function spanNames(): Promise<string[]> {
    const spans = (await backgroundLogger.drain()) as Record<string, any>[];
    return spans.map((span) => span.span_attributes.name);
  }

  it("traces handlers registered before and after wrapping an McpServer", async () => {
    const protocol = new FakeProtocol();
    const mcpServer = { server: protocol };
    protocol.setRequestHandler("tools/call", async () => ({ content: [] }));

    expect(wrapMCPServer(mcpServer)).toBe(mcpServer);
    protocol.setRequestHandler("prompts/get", async () => ({ messages: [] }));

    if (!protocol.transport) await protocol.connect({ start() {}, send() {} });
    await protocol.handle("tools/call", { name: "early" });
    if (!protocol.transport) await protocol.connect({ start() {}, send() {} });
    await protocol.handle("prompts/get", { name: "late" });

    expect(await spanNames()).toEqual(["tools/call early", "prompts/get late"]);
  });

  it("wraps a low-level server idempotently", async () => {
    const protocol = new FakeProtocol();

    wrapMCPServer(protocol);
    wrapMCPServer(protocol);
    protocol.setRequestHandler("tools/call", async () => ({ content: [] }));
    if (!protocol.transport) await protocol.connect({ start() {}, send() {} });
    await protocol.handle("tools/call", { name: "once" });

    expect(await spanNames()).toEqual(["tools/call once"]);
  });

  it("creates one span when auto-instrumentation also wrapped the handler", async () => {
    const protocol = new FakeProtocol();
    const handler = async () => ({ content: [] });
    // Mirror the v1 registry, which stores a closure around the registered handler.
    mcpSDKChannels.setRequestHandler.invoke(
      (method: unknown, registered: unknown) =>
        protocol._requestHandlers.set(method as string, (request, extra) =>
          (registered as MCPRequestHandler)(request, extra),
        ),
      protocol,
      ["tools/call", handler],
      {},
    );

    wrapMCPServer({ server: protocol });
    if (!protocol.transport) await protocol.connect({ start() {}, send() {} });
    await protocol.handle("tools/call", { name: "deduplicated" });

    expect(await spanNames()).toEqual(["tools/call deduplicated"]);
  });

  it("returns unsupported values unchanged", () => {
    const warn = vi
      .spyOn(debugLogger.notice, "warn")
      .mockImplementation(() => true);
    const value = { connect() {} };

    expect(wrapMCPServer(value)).toBe(value);
    expect(warn).toHaveBeenCalledWith("Unsupported MCP server. Not wrapping.");
  });

  it("wraps servers before initialization and preserves factory and callback semantics", async () => {
    const protocol = new FakeProtocol();
    const server = { server: protocol };
    const receiver = {};
    const initReceiver = {};
    const options = {};
    const config = {};
    const ready = Promise.resolve();
    const handler = async () => new Response();
    const initialize = vi.fn(function (
      this: unknown,
      value: typeof server,
      extra: unknown,
    ) {
      expect(this).toBe(initReceiver);
      expect(value).toBe(server);
      expect(extra).toBe("extra");
      value.server.setRequestHandler("tools/call", async () => ({
        content: [],
      }));
      return ready;
    });
    const factory = vi.fn(function (
      this: unknown,
      init: typeof initialize,
      receivedOptions: unknown,
      receivedConfig: unknown,
    ) {
      expect(this).toBe(receiver);
      expect(receivedOptions).toBe(options);
      expect(receivedConfig).toBe(config);
      expect(init.call(initReceiver, server, "extra")).toBe(ready);
      return handler;
    });
    const wrapped = wrapMCPHandler(factory);
    expect(wrapMCPHandler(factory)).toBe(wrapped);
    expect(wrapMCPHandler(wrapped)).toBe(wrapped);
    expect(wrapped.call(receiver, initialize, options, config)).toBe(handler);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);

    await protocol.connect({ start() {}, send() {} });
    await protocol.handle("tools/call", { name: "from-handler" });
    expect(await spanNames()).toEqual(["tools/call from-handler"]);
  });

  it("preserves initializer failures without retrying", () => {
    const error = new Error("initialization failed");
    const initialize = vi.fn((_server: { server: FakeProtocol }) => {
      throw error;
    });
    const factory = (init: typeof initialize) =>
      init({ server: new FakeProtocol() });
    expect(() => wrapMCPHandler(factory)(initialize)).toThrow(error);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("passes factory arguments through unchanged when instrumentation is disabled", () => {
    registry.disable();
    try {
      const initialize = () => {};
      const handler = () => {};
      const factory = vi.fn(() => handler);
      const options = {};
      expect(
        Reflect.apply(wrapMCPHandler(factory), null, [initialize, options]),
      ).toBe(handler);
      expect(factory).toHaveBeenCalledWith(initialize, options);
    } finally {
      registry.enable();
    }
  });

  it("returns unsupported MCP handler factories unchanged", () => {
    const warn = vi
      .spyOn(debugLogger.notice, "warn")
      .mockImplementation(() => true);
    const value = {};
    expect(wrapMCPHandler(value)).toBe(value);
    expect(warn).toHaveBeenCalledWith(
      "Unsupported MCP handler factory. Not wrapping.",
    );
  });
});
