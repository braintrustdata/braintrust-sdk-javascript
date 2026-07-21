import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStartSpan } = vi.hoisted(() => ({
  mockStartSpan: vi.fn(),
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...args),
}));

vi.mock("../../isomorph", () => ({
  default: {
    getEnv: vi.fn(),
    newTracingChannel: vi.fn(),
  },
}));

import iso from "../../isomorph";
import { CloudflareAgentsPlugin } from "./cloudflare-agents-plugin";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("CloudflareAgentsPlugin", () => {
  let handlers: any;
  let subscribe: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let spans: Array<{
    args: any;
    end: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  }>;

  beforeEach(() => {
    spans = [];
    subscribe = vi.fn((nextHandlers) => {
      handlers = nextHandlers;
    });
    unsubscribe = vi.fn();
    mockNewTracingChannel.mockReturnValue({ subscribe, unsubscribe });
    mockStartSpan.mockImplementation((args: any) => {
      const span = { args, end: vi.fn(), log: vi.fn() };
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes idempotently to Agent.runAgentTool", () => {
    const plugin = new CloudflareAgentsPlugin();
    plugin.enable();
    plugin.enable();

    expect(mockNewTracingChannel).toHaveBeenCalledWith(
      "orchestrion:agents:Agent.runAgentTool",
    );
    expect(subscribe).toHaveBeenCalledTimes(1);

    plugin.disable();
    plugin.disable();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("records only the child class name, input, and completed output", () => {
    new CloudflareAgentsPlugin().enable();
    class ResearchAgent {}
    const event = {
      arguments: [
        ResearchAgent,
        {
          input: { query: "cloudflare" },
          runId: "secret-run-id",
          inputPreview: "secret-preview",
          display: { name: "secret-display" },
        },
      ],
    };

    handlers.start(event);
    handlers.asyncEnd(
      Object.assign(event, {
        result: {
          status: "completed",
          output: { answer: 42 },
          runId: "secret-result-run-id",
          agentType: "secret-agent-type",
          summary: "secret-summary",
        },
      }),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0].args).toEqual({
      name: "ResearchAgent",
      spanAttributes: { type: "tool" },
      context: {
        span_origin: {
          name: "braintrust.sdk.javascript",
          version: expect.any(String),
          instrumentation: { name: "cloudflare-agents" },
          environment: { type: "server", name: "cloudflare_workers" },
        },
      },
      event: {
        input: { query: "cloudflare" },
      },
    });
    expect(spans[0].log).toHaveBeenCalledExactlyOnceWith({
      output: { answer: 42 },
    });
    expect(spans[0].end).toHaveBeenCalledTimes(1);
  });

  it("records returned terminal error strings", () => {
    new CloudflareAgentsPlugin().enable();
    class FailingAgent {}
    const event = { arguments: [FailingAgent, { input: "fail" }] };

    handlers.start(event);
    handlers.asyncEnd(
      Object.assign(event, {
        result: {
          status: "error",
          error: "child failed",
          reason: "do not record",
        },
      }),
    );

    expect(spans[0].log).toHaveBeenCalledExactlyOnceWith({
      error: "child failed",
    });
    expect(spans[0].end).toHaveBeenCalledTimes(1);
  });

  it("records the original rejection and preserves concurrent span state", () => {
    new CloudflareAgentsPlugin().enable();
    class FirstAgent {}
    class SecondAgent {}
    const first = { arguments: [FirstAgent, { input: 1 }] };
    const second = { arguments: [SecondAgent, { input: 2 }] };
    const rejection = new Error("rejected");

    handlers.start(first);
    handlers.start(second);
    handlers.error(Object.assign(second, { error: rejection }));
    handlers.asyncEnd(
      Object.assign(first, {
        result: { status: "completed", output: "first" },
      }),
    );

    expect(spans).toHaveLength(2);
    expect(spans[0].log).toHaveBeenCalledWith({ output: "first" });
    expect(spans[1].log).toHaveBeenCalledWith({ error: rejection });
    expect(spans[0].end).toHaveBeenCalledTimes(1);
    expect(spans[1].end).toHaveBeenCalledTimes(1);
  });

  it("skips detached runs and does not invoke getters", () => {
    new CloudflareAgentsPlugin().enable();
    const nameGetter = vi.fn(() => "GetterAgent");
    const inputGetter = vi.fn(() => "getter-input");
    const AgentWithGetter = Object.defineProperty(function () {}, "name", {
      get: nameGetter,
    });
    const options = Object.defineProperties(
      {},
      {
        detached: { value: true },
        input: { get: inputGetter },
      },
    );

    handlers.start({ arguments: [AgentWithGetter, options] });

    expect(spans).toHaveLength(0);
    expect(nameGetter).not.toHaveBeenCalled();
    expect(inputGetter).not.toHaveBeenCalled();
  });
});
