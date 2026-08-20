import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type { StartSpanArgs } from "../../logger";
import {
  getSpanInstrumentationName,
  INSTRUMENTATION_NAMES,
} from "../../span-origin";

const { mockStartSpan } = vi.hoisted(() => ({
  mockStartSpan: vi.fn(),
}));

vi.mock("../../logger", () => ({
  _internalStartSpanWithContext: (...args: unknown[]) => mockStartSpan(...args),
}));

vi.mock("../../isomorph", () => ({
  default: {
    getEnv: vi.fn(),
    newTracingChannel: vi.fn(),
  },
}));

import iso from "../../isomorph";
import { registerCloudflareAgentsInstrumentation } from "./cloudflare-agents-instrumentation";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("registerCloudflareAgentsInstrumentation", () => {
  let handlers: any;
  let subscribe: ReturnType<typeof vi.fn>;
  let spans: Array<{
    args: any;
    context: any;
    end: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  }>;

  beforeEach(() => {
    spans = [];
    subscribe = vi.fn((nextHandlers) => {
      handlers = nextHandlers;
    });
    mockNewTracingChannel.mockReturnValue({ subscribe });
    mockStartSpan.mockImplementation((args: any, context: any) => {
      const span = { args, context, end: vi.fn(), log: vi.fn() };
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to the process-lifetime channel", () => {
    registerCloudflareAgentsInstrumentation();

    expect(mockNewTracingChannel).toHaveBeenCalledWith(
      "orchestrion:agents:Agent.runAgentTool",
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps SDK-controlled context out of the public start-span arguments", () => {
    type HasPublicContext = "context" extends keyof StartSpanArgs
      ? true
      : false;

    expectTypeOf<HasPublicContext>().toEqualTypeOf<false>();
  });

  it("records only the child class name, input, and completed output", () => {
    registerCloudflareAgentsInstrumentation();
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
    expect(spans[0].args).toMatchObject({
      name: "ResearchAgent",
      spanAttributes: { type: "tool" },
      event: {
        input: { query: "cloudflare" },
      },
    });
    expect(Object.keys(spans[0].args).sort()).toEqual([
      "event",
      "name",
      "spanAttributes",
    ]);
    expect(spans[0].args).not.toHaveProperty("context");
    expect(getSpanInstrumentationName(spans[0].args)).toBe(
      INSTRUMENTATION_NAMES.CLOUDFLARE_AGENTS,
    );
    expect(spans[0].context).toEqual({
      span_origin: {
        environment: { type: "server", name: "cloudflare_workers" },
      },
    });
    expect(spans[0].log).toHaveBeenCalledExactlyOnceWith({
      output: { answer: 42 },
    });
    expect(spans[0].end).toHaveBeenCalledTimes(1);
  });

  it("records returned terminal error strings", () => {
    registerCloudflareAgentsInstrumentation();
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
    registerCloudflareAgentsInstrumentation();
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
    registerCloudflareAgentsInstrumentation();
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
