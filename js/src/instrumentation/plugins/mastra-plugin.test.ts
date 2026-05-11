import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCurrentSpanStoreSymbol: MOCK_CURRENT_SPAN_STORE_SYMBOL,
  mockInternalGetGlobalState,
} = vi.hoisted(() => ({
  mockCurrentSpanStoreSymbol: Symbol.for("braintrust.currentSpanStore"),
  mockInternalGetGlobalState: vi.fn(() => undefined),
}));

vi.mock("../../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
  },
}));

const mockStartSpan = vi.fn(() => ({
  log: vi.fn(),
  end: vi.fn(),
  spanId: "span-id",
  rootSpanId: "root-span-id",
  export: vi.fn(() => Promise.resolve("span-id")),
}));

vi.mock("../../logger", () => ({
  startSpan: (...args: any[]) => mockStartSpan(...args),
  _internalGetGlobalState: (...args: any[]) =>
    mockInternalGetGlobalState(...args),
  BRAINTRUST_CURRENT_SPAN_STORE: MOCK_CURRENT_SPAN_STORE_SYMBOL,
}));

import iso from "../../isomorph";
import { MastraPlugin } from "./mastra-plugin";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("MastraPlugin", () => {
  let channels: Map<string, any>;

  beforeEach(() => {
    channels = new Map();
    mockNewTracingChannel.mockImplementation((name: string) => {
      const channel = {
        name,
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        start: {
          bindStore: vi.fn(),
          unbindStore: vi.fn(),
        },
      };
      channels.set(name, channel);
      return channel;
    });
    mockStartSpan.mockClear();
    mockInternalGetGlobalState.mockReset();
    mockInternalGetGlobalState.mockReturnValue(undefined);
  });

  function subscribedHandlers(channelName: string) {
    const channel = channels.get(`orchestrion:@mastra/core:${channelName}`);
    expect(channel).toBeDefined();
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
    return channel.subscribe.mock.calls[0][0];
  }

  it("subscribes to all Mastra channels", () => {
    const plugin = new MastraPlugin();

    plugin.enable();

    expect(mockNewTracingChannel).toHaveBeenCalledWith(
      "orchestrion:@mastra/core:agent.execute",
    );
    expect(mockNewTracingChannel).toHaveBeenCalledWith(
      "orchestrion:@mastra/core:tool.execute",
    );
    expect(mockNewTracingChannel).toHaveBeenCalledWith(
      "orchestrion:@mastra/core:workflow.run.start",
    );
    expect(mockNewTracingChannel).toHaveBeenCalledWith(
      "orchestrion:@mastra/core:workflow.step.execute",
    );
  });

  it("creates an agent task span with method metadata", () => {
    const plugin = new MastraPlugin();
    plugin.enable();
    const handlers = subscribedHandlers("agent.execute");
    const event: any = {
      self: { name: "Weather Agent", id: "weather-agent" },
      arguments: [
        {
          methodType: "generate",
          messages: "What is the weather?",
          runId: "run-1",
          resourceId: "resource-1",
        },
      ],
    };

    handlers.start(event);
    handlers.asyncEnd({ ...event, result: { text: "Sunny" } });

    const span = mockStartSpan.mock.results[0].value;
    expect(mockStartSpan).toHaveBeenCalledWith({
      name: "Mastra Agent Weather Agent generate",
      spanAttributes: { type: "task" },
    });
    expect(span.log).toHaveBeenCalledWith({
      input: "What is the weather?",
      metadata: {
        agent_id: "weather-agent",
        agent_name: "Weather Agent",
        method: "generate",
        resource_id: "resource-1",
        run_id: "run-1",
      },
    });
    expect(span.log).toHaveBeenCalledWith({
      output: { text: "Sunny" },
      metadata: {},
      metrics: {},
    });
    expect(span.end).toHaveBeenCalled();
  });

  it("creates a tool span with workflow context", () => {
    const plugin = new MastraPlugin();
    plugin.enable();
    const handlers = subscribedHandlers("tool.execute");
    const event: any = {
      self: { id: "lookup_weather" },
      arguments: [
        { city: "Paris" },
        {
          workflow: {
            workflowId: "travel-flow",
            runId: "workflow-run",
          },
        },
      ],
    };

    handlers.start(event);
    handlers.asyncEnd({ ...event, result: { forecast: "Sunny" } });

    const span = mockStartSpan.mock.results[0].value;
    expect(mockStartSpan).toHaveBeenCalledWith({
      name: "Mastra Tool lookup_weather",
      spanAttributes: { type: "tool" },
    });
    expect(span.log).toHaveBeenCalledWith({
      input: { city: "Paris" },
      metadata: {
        tool_id: "lookup_weather",
        workflow_id: "travel-flow",
        workflow_run_id: "workflow-run",
      },
    });
    expect(span.log).toHaveBeenCalledWith({
      output: { forecast: "Sunny" },
      metadata: {},
      metrics: {},
    });
  });

  it("creates workflow run and step spans", () => {
    const plugin = new MastraPlugin();
    plugin.enable();

    subscribedHandlers("workflow.run.start").start({
      self: { workflowId: "travel-flow", runId: "run-1" },
      arguments: [{ inputData: { city: "Paris" } }],
    });
    subscribedHandlers("workflow.step.execute").start({
      arguments: [
        "lookup-step",
        () => undefined,
        { workflowId: "travel-flow", runId: "run-1" },
      ],
    });

    expect(mockStartSpan).toHaveBeenCalledWith({
      name: "Mastra Workflow travel-flow start",
      spanAttributes: { type: "task" },
    });
    expect(mockStartSpan).toHaveBeenCalledWith({
      name: "Mastra Workflow Step lookup-step",
      spanAttributes: { type: "function" },
    });
  });

  it("logs errors and unsubscribes on disable", () => {
    const plugin = new MastraPlugin();
    plugin.enable();
    const handlers = subscribedHandlers("workflow.step.execute");
    const event: any = {
      arguments: [
        "lookup-step",
        () => undefined,
        { workflowId: "travel-flow", runId: "run-1" },
      ],
    };

    handlers.start(event);
    handlers.error({ ...event, error: new Error("step failed") });
    plugin.disable();

    const span = mockStartSpan.mock.results[0].value;
    expect(span.log).toHaveBeenCalledWith({ error: "step failed" });
    expect(span.end).toHaveBeenCalled();
    for (const channel of channels.values()) {
      expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
    }
  });

  it("binds current span context on channel start", () => {
    const contextManager = {
      wrapSpanForStore: vi.fn((span) => ({ span })),
      [MOCK_CURRENT_SPAN_STORE_SYMBOL]: { store: "current-span" },
    };
    mockInternalGetGlobalState.mockReturnValue({ contextManager });

    const plugin = new MastraPlugin();
    plugin.enable();
    const channel = channels.get("orchestrion:@mastra/core:agent.execute");
    const event: any = {
      self: { name: "Weather Agent" },
      arguments: [{ methodType: "generate", messages: "Hello" }],
    };
    const bindCallback = channel.start.bindStore.mock.calls[0][1];

    const storeValue = bindCallback(event);

    expect(storeValue).toEqual({ span: mockStartSpan.mock.results[0].value });
    expect(contextManager.wrapSpanForStore).toHaveBeenCalledWith(
      mockStartSpan.mock.results[0].value,
    );
  });
});
