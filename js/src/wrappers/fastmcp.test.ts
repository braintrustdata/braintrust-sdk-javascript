import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { debugLogger } from "../debug-logger";
import { _exportsForTestingOnly, initLogger, traced } from "../logger";
import { configureNode } from "../node/config";
import { registry } from "../instrumentation/registry";
import type {
  MCPProtocol,
  MCPRequest,
  MCPRequestHandler,
  MCPTransport,
} from "../vendor-sdk-types/mcp";
import { wrapFastMCP } from "./fastmcp";

configureNode();

function createModule() {
  class FastMCPSession {
    readonly server: MCPProtocol = {
      _requestHandlers: new Map<string, MCPRequestHandler>([
        [
          "tools/call",
          async () =>
            traced(
              async () => ({ content: [{ type: "text", text: "sunny" }] }),
              { name: "lookup" },
            ),
        ],
      ]),
      setRequestHandler() {},
      connect: (transport) => {
        Object.assign(this.server, { transport });
        transport.onmessage = async (message) => {
          const request = message as MCPRequest;
          const result = await this.server._requestHandlers!.get(
            request.method,
          )!(request, { requestId: request.id });
          return transport.send({ id: request.id, result });
        };
        return transport.start();
      },
    };
    connect(transport: MCPTransport): Promise<void> {
      return this.server.connect(transport) as Promise<void>;
    }
  }
  return { FastMCPSession };
}

describe("FastMCP wrapper", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    registry.disable();
    registry.configure({ integrations: { mcp: false, fastmcp: true } });
    registry.enable();
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "fastmcp.test.ts",
      projectId: "test-project-id",
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it.each([false, true])(
    "traces queued requests and nested context with a null prototype: %s",
    async (nullPrototype) => {
      const module: ReturnType<typeof createModule> = Object.assign(
        Object.create(nullPrototype ? null : Object.prototype),
        createModule(),
      );
      expect(wrapFastMCP(module)).toBe(module);
      wrapFastMCP(module);
      const session = new module.FastMCPSession();
      const send = vi.fn();
      const transport: MCPTransport = {
        start() {
          return this.onmessage!({
            id: 1,
            method: "tools/call",
            params: { name: "weather", arguments: { city: "Vienna" } },
          });
        },
        send,
      };
      await session.connect(transport);
      expect(send).toHaveBeenCalledOnce();
      const spans = (await backgroundLogger.drain()) as Record<string, any>[];
      const request = spans.find(
        (span) => span.span_attributes.name === "tools/call weather",
      )!;
      expect(spans).toHaveLength(2);
      expect(request.input).toEqual({ city: "Vienna" });
      expect(request.output).toEqual({
        content: [{ type: "text", text: "sunny" }],
      });
      expect(
        spans.find((span) => span.span_attributes.name === "lookup")
          ?.span_parents,
      ).toEqual([request.span_id]);
    },
  );

  it("preserves the receiver, arguments, and promise identity", async () => {
    const module = createModule();
    const result = Object.assign(Promise.resolve(), { helper: () => "value" });
    const original = vi
      .spyOn(module.FastMCPSession.prototype, "connect")
      .mockReturnValue(result);
    wrapFastMCP(module);
    const session = new module.FastMCPSession();
    const transport = { start() {}, send() {} };
    expect(session.connect(transport)).toBe(result);
    expect(original).toHaveBeenCalledWith(transport);
    expect(original.mock.contexts).toEqual([session]);
    await result;
  });

  it("passes through when the FastMCP integration is disabled", async () => {
    registry.disable();
    registry.configure({ integrations: { mcp: false, fastmcp: false } });
    registry.enable();
    const module = wrapFastMCP(createModule());
    const session = new module.FastMCPSession();
    const transport = { start() {}, send() {} };
    await session.connect(transport);
    expect(session.server.transport).toBe(transport);
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("preserves synchronous errors from connect", () => {
    const module = createModule();
    const error = new Error("connect failed");
    vi.spyOn(module.FastMCPSession.prototype, "connect").mockImplementation(
      () => {
        throw error;
      },
    );
    const session = new (wrapFastMCP(module).FastMCPSession)();
    expect(() => session.connect({ start() {}, send() {} })).toThrow(error);
  });

  it("returns unsupported values unchanged", () => {
    const warn = vi
      .spyOn(debugLogger.notice, "warn")
      .mockImplementation(() => true);
    for (const value of [null, {}, { FastMCPSession: () => {} }]) {
      expect(wrapFastMCP(value)).toBe(value);
    }
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
