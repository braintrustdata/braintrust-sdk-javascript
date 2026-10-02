import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { newGlobalInvocationHook } from "../../global-instrumentation-hooks";
import type { StartSpanArgs } from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  getSpanInstrumentationName,
} from "../../span-origin";
import { invocationController } from "../test-utils/invocation";
vi.mock("../../global-instrumentation-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../global-instrumentation-hooks")
  >()),
  newGlobalInvocationHook: vi.fn(),
}));

const { mockStartSpan } = vi.hoisted(() => ({
  mockStartSpan: vi.fn(),
}));

vi.mock("../../logger", () => ({
  _internalStartSpanWithContext: (...args: unknown[]) => mockStartSpan(...args),
}));

vi.mock("../../isomorph", () => ({
  default: {
    getEnv: vi.fn(),
  },
}));

import { CloudflareAgentsPlugin } from "./cloudflare-agents-plugin";

const mockNewInvocationHook = newGlobalInvocationHook as ReturnType<
  typeof vi.fn
>;

describe("CloudflareAgentsPlugin", () => {
  let handlers: any;
  let subscribe: ReturnType<typeof vi.fn<(value: any) => void>>;
  let unsubscribe: ReturnType<typeof vi.fn>;
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
    unsubscribe = vi.fn();
    mockNewInvocationHook.mockReturnValue({
      intercept: (interceptor: any) => {
        subscribe(invocationController(interceptor));
        return unsubscribe;
      },
    });
    mockStartSpan.mockImplementation((args: any, context: any) => {
      const span = { args, context, end: vi.fn(), log: vi.fn() };
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

    expect(mockNewInvocationHook).toHaveBeenCalledWith(
      "orchestrion:agents:Agent.runAgentTool",
    );
    expect(subscribe).toHaveBeenCalledTimes(1);

    plugin.disable();
    plugin.disable();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps SDK-controlled context out of the public start-span arguments", () => {
    type HasPublicContext = "context" extends keyof StartSpanArgs
      ? true
      : false;

    expectTypeOf<HasPublicContext>().toEqualTypeOf<false>();
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

    handlers.begin(event);
    handlers.resolve(
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
    new CloudflareAgentsPlugin().enable();
    class FailingAgent {}
    const event = { arguments: [FailingAgent, { input: "fail" }] };

    handlers.begin(event);
    handlers.resolve(
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

    handlers.begin(first);
    handlers.begin(second);
    handlers.reject(Object.assign(second, { error: rejection }));
    handlers.resolve(
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

    handlers.begin({ arguments: [AgentWithGetter, options] });

    expect(spans).toHaveLength(0);
    expect(nameGetter).not.toHaveBeenCalled();
    expect(inputGetter).not.toHaveBeenCalled();
  });
});
