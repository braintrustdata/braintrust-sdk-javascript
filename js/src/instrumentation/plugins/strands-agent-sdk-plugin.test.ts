import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBindStore,
  mockWithCurrent,
  mockNewAsyncLocalStorage,
  mockStartSpan,
  mockUnbindStore,
} = vi.hoisted(() => ({
  mockBindStore: vi.fn(),
  mockWithCurrent: vi.fn(),
  mockNewAsyncLocalStorage: vi.fn(() => {
    let current: unknown;
    return {
      enterWith: vi.fn((store: unknown) => {
        current = store;
      }),
      getStore: vi.fn(() => current),
      run: vi.fn((store: unknown, callback: () => unknown) => {
        const previous = current;
        current = store;
        try {
          return callback();
        } finally {
          current = previous;
        }
      }),
    };
  }),
  mockStartSpan: vi.fn(),
  mockUnbindStore: vi.fn(),
}));

vi.mock("../../isomorph", () => ({
  default: {
    getEnv: vi.fn(),
    newAsyncLocalStorage: mockNewAsyncLocalStorage,
    newTracingChannel: vi.fn(),
  },
}));

vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    startSpan: (...args: unknown[]) => mockStartSpan(...args),
    withCurrent: (...args: unknown[]) => mockWithCurrent(...args),
  };
});

import iso from "../../isomorph";
import { Attachment } from "../../logger";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { StrandsAgentSDKPlugin } from "./strands-agent-sdk-plugin";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("StrandsAgentSDKPlugin", () => {
  let handlersByName: Map<string, any>;
  let spans: Array<{
    args: any;
    end: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
    rootSpanId: string;
    spanId: string;
  }>;
  let currentSpan:
    | {
        rootSpanId: string;
        spanId: string;
      }
    | undefined;

  beforeEach(() => {
    handlersByName = new Map();
    spans = [];
    mockNewTracingChannel.mockImplementation((name: string) => ({
      start: {
        bindStore: mockBindStore,
        unbindStore: mockUnbindStore,
      },
      subscribe: vi.fn((handlers) => handlersByName.set(name, handlers)),
      traceSync: vi.fn((fn) => fn()),
      unsubscribe: vi.fn(),
    }));
    currentSpan = undefined;
    mockWithCurrent.mockImplementation((span: any, callback: () => unknown) => {
      const previous = currentSpan;
      currentSpan = span;
      try {
        return callback();
      } finally {
        currentSpan = previous;
      }
    });
    mockStartSpan.mockImplementation((args: any) => {
      const parentSpanIds =
        args.parentSpanIds ??
        (currentSpan
          ? {
              rootSpanId: currentSpan.rootSpanId,
              spanId: currentSpan.spanId,
            }
          : undefined);
      const effectiveArgs = parentSpanIds ? { ...args, parentSpanIds } : args;
      const span = {
        args: effectiveArgs,
        end: vi.fn(),
        log: vi.fn(),
        rootSpanId: parentSpanIds?.rootSpanId ?? `root-${spans.length}`,
        spanId: `span-${spans.length}`,
      };
      if (effectiveArgs.event) {
        span.log(effectiveArgs.event);
      }
      spans.push(span);
      return span;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to Strands stream channels and binds suppression", () => {
    const plugin = new StrandsAgentSDKPlugin();
    plugin.enable();

    expect(
      handlersByName.has("orchestrion:@strands-agents/sdk:Agent.stream"),
    ).toBe(true);
    expect(
      handlersByName.has("orchestrion:@strands-agents/sdk:Graph.stream"),
    ).toBe(true);
    expect(
      handlersByName.has("orchestrion:@strands-agents/sdk:Swarm.stream"),
    ).toBe(true);
    expect(mockBindStore).toHaveBeenCalledTimes(3);

    plugin.disable();

    expect(mockUnbindStore).toHaveBeenCalledTimes(3);
  });

  it("records agent model and tool spans from stream events", async () => {
    const plugin = new StrandsAgentSDKPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@strands-agents/sdk:Agent.stream",
    );
    class OpenAIModel {
      modelId = "gpt-4o-mini";

      getConfig() {
        return { api: "responses", modelId: "gpt-4o-mini" };
      }
    }
    const model = new OpenAIModel();
    const agent = {
      id: "agent-1",
      messages: [{ role: "user", content: [{ text: "hello" }] }],
      model,
      name: "helper",
      stream: vi.fn(),
    };
    const suppressionStates: boolean[] = [];
    const stream = makeAgentStream(
      [
        { agent, model, projectedInputTokens: 3, type: "beforeModelCallEvent" },
        {
          event: {
            metrics: { latencyMs: 50, timeToFirstByteMs: 10 },
            type: "modelMetadataEvent",
            usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
          },
          type: "modelStreamUpdateEvent",
        },
        {
          agent,
          attemptCount: 1,
          model,
          stopData: {
            message: { role: "assistant", content: [{ text: "call tool" }] },
            stopReason: "tool_use",
          },
          type: "afterModelCallEvent",
        },
        {
          toolUse: {
            input: { city: "Vienna" },
            name: "lookup_weather",
            toolUseId: "tool-1",
          },
          type: "beforeToolCallEvent",
        },
        {
          result: {
            content: [{ text: "sunny" }],
            status: "success",
            toolUseId: "tool-1",
          },
          toolUse: {
            input: { city: "Vienna" },
            name: "lookup_weather",
            toolUseId: "tool-1",
          },
          type: "afterToolCallEvent",
        },
        {
          result: {
            lastMessage: { role: "assistant", content: [{ text: "sunny" }] },
            metrics: {
              accumulatedUsage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
              },
            },
            stopReason: "end_turn",
          },
          type: "agentResultEvent",
        },
      ],
      () => suppressionStates.push(isAutoInstrumentationSuppressed()),
    );
    const event = {
      arguments: ["hello", undefined],
      moduleVersion: "1.6.0",
      result: stream,
      self: agent,
    };

    handlers.start(event);
    handlers.end(event);
    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(6);
    expect(suppressionStates).toEqual([true, true, true, true, true, true]);
    const rootSpan = spans.find((span) => span.args.name === "Agent: helper");
    const modelSpan = spans.find(
      (span) => span.args.name === "Strands model: gpt-4o-mini",
    );
    const toolSpan = spans.find(
      (span) => span.args.name === "tool: lookup_weather",
    );

    expect(rootSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          "strands.agent.id": "agent-1",
          "strands.operation": "Agent.stream",
          model: "gpt-4o-mini",
          provider: "openai",
        }),
      }),
    );
    expect(modelSpan?.args.parentSpanIds).toEqual({
      rootSpanId: rootSpan?.rootSpanId,
      spanId: rootSpan?.spanId,
    });
    expect(modelSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          completion_tokens: 4,
          prompt_tokens: 3,
          tokens: 7,
        }),
      }),
    );
    expect(toolSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ status: "success" }),
      }),
    );
    expect(rootSpan?.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["binary objects", new Uint8Array([1, 2, 3])],
    ["base64 strings", "AQID"],
  ])(
    "converts media from %s to one attachment shared by agent and model spans",
    async (_description, bytes) => {
      const plugin = new StrandsAgentSDKPlugin();
      plugin.enable();

      const handlers = handlersByName.get(
        "orchestrion:@strands-agents/sdk:Agent.stream",
      );
      const documentBlock = {
        format: "pdf",
        name: "tiny.pdf",
        source: { bytes, type: "documentSourceBytes" },
        type: "documentBlock",
      };
      const model = {
        modelId: "gpt-4o-mini",
        getConfig: () => ({ modelId: "gpt-4o-mini" }),
      };
      const agent = {
        messages: [{ content: [documentBlock], role: "user", type: "message" }],
        model,
        stream: vi.fn(),
      };
      const stream = makeAgentStream([
        { agent, model, type: "beforeModelCallEvent" },
        {
          result: {
            lastMessage: { role: "assistant", content: [{ text: "done" }] },
            stopReason: "end_turn",
          },
          type: "agentResultEvent",
        },
      ]);
      const event = {
        arguments: [[documentBlock], undefined],
        result: stream,
        self: agent,
      };

      handlers.start(event);
      handlers.end(event);
      await consume(stream);

      const rootSpan = spans.find((span) => span.args.name === "Strands Agent");
      const modelSpan = spans.find(
        (span) => span.args.name === "Strands model: gpt-4o-mini",
      );
      const rootAttachment =
        rootSpan?.args.event.input[0].document.source.bytes;
      const modelAttachment =
        modelSpan?.args.event.input[0].content[0].document.source.bytes;

      expect(rootAttachment).toBeInstanceOf(Attachment);
      expect(rootAttachment.reference).toMatchObject({
        content_type: "application/pdf",
        filename: "tiny.pdf",
        type: "braintrust_attachment",
      });
      expect(modelAttachment).toBe(rootAttachment);
    },
  );

  it("parents nested agent spans under active graph nodes", async () => {
    const plugin = new StrandsAgentSDKPlugin();
    plugin.enable();

    const graphHandlers = handlersByName.get(
      "orchestrion:@strands-agents/sdk:Graph.stream",
    );
    const agentHandlers = handlersByName.get(
      "orchestrion:@strands-agents/sdk:Agent.stream",
    );
    const agent = {
      model: { getConfig: () => ({ modelId: "gpt-4o-mini" }) },
      name: "worker",
      stream: vi.fn(),
    };
    const graph = {
      id: "graph-1",
      nodes: new Map([["worker", { agent, id: "worker", type: "agentNode" }]]),
      stream: vi.fn(),
    };
    const graphStream = makeMultiAgentStream([
      { nodeId: "worker", orchestrator: graph, type: "beforeNodeCallEvent" },
      {
        nodeId: "worker",
        nodeType: "agentNode",
        result: {
          content: [{ text: "node done" }],
          nodeId: "worker",
          status: "COMPLETED",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
        type: "nodeResultEvent",
      },
      { nodeId: "worker", orchestrator: graph, type: "afterNodeCallEvent" },
      {
        result: {
          content: [{ text: "graph done" }],
          status: "COMPLETED",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
        type: "multiAgentResultEvent",
      },
    ]);
    const graphEvent = {
      arguments: ["work", undefined],
      result: graphStream,
      self: graph,
    };

    graphHandlers.start(graphEvent);
    graphHandlers.end(graphEvent);
    const iterator = graphStream[Symbol.asyncIterator]();
    await iterator.next();

    const agentStream = makeAgentStream([
      {
        result: {
          lastMessage: { role: "assistant", content: [{ text: "nested" }] },
          stopReason: "end_turn",
        },
        type: "agentResultEvent",
      },
    ]);
    const agentEvent = {
      arguments: ["node work", undefined],
      result: agentStream,
      self: agent,
    };
    agentHandlers.start(agentEvent);
    agentHandlers.end(agentEvent);
    for await (const _chunk of agentStream) {
      // consume nested agent stream
    }
    await iterator.next();
    await iterator.next();
    await iterator.next();
    await iterator.next();

    const nodeSpan = spans.find((span) => span.args.name === "node: worker");
    const agentSpan = spans.find((span) => span.args.name === "Agent: worker");

    expect(agentSpan?.args.parentSpanIds).toEqual({
      rootSpanId: nodeSpan?.rootSpanId,
      spanId: nodeSpan?.spanId,
    });
    expect(nodeSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("parents nested graph spans under active graph nodes", async () => {
    const plugin = new StrandsAgentSDKPlugin();
    plugin.enable();

    const graphHandlers = handlersByName.get(
      "orchestrion:@strands-agents/sdk:Graph.stream",
    );
    const innerGraph = {
      id: "inner-graph",
      nodes: new Map(),
      stream: vi.fn(),
    };
    const outerGraph = {
      id: "outer-graph",
      nodes: new Map([
        ["inner", { id: "inner", orchestrator: innerGraph, type: "graphNode" }],
      ]),
      stream: vi.fn(),
    };
    const outerStream = makeMultiAgentStream([
      {
        nodeId: "inner",
        orchestrator: outerGraph,
        type: "beforeNodeCallEvent",
      },
      {
        nodeId: "inner",
        nodeType: "graphNode",
        result: {
          content: [{ text: "inner done" }],
          nodeId: "inner",
          status: "COMPLETED",
        },
        type: "nodeResultEvent",
      },
      { nodeId: "inner", orchestrator: outerGraph, type: "afterNodeCallEvent" },
      {
        result: { content: [{ text: "outer done" }], status: "COMPLETED" },
        type: "multiAgentResultEvent",
      },
    ]);
    const outerEvent = {
      arguments: ["outer work", undefined],
      result: outerStream,
      self: outerGraph,
    };

    graphHandlers.start(outerEvent);
    graphHandlers.end(outerEvent);
    const outerIterator = outerStream[Symbol.asyncIterator]();
    await outerIterator.next();

    const innerStream = makeMultiAgentStream([
      {
        result: { content: [{ text: "nested done" }], status: "COMPLETED" },
        type: "multiAgentResultEvent",
      },
    ]);
    const innerEvent = {
      arguments: ["inner work", undefined],
      result: innerStream,
      self: innerGraph,
    };

    graphHandlers.start(innerEvent);
    graphHandlers.end(innerEvent);
    for await (const _chunk of innerStream) {
      // consume nested graph stream
    }
    await outerIterator.next();
    await outerIterator.next();
    await outerIterator.next();
    await outerIterator.next();

    const nodeSpan = spans.find((span) => span.args.name === "node: inner");
    const innerGraphSpan = spans.find(
      (span) =>
        span.args.name === "Strands Graph" &&
        span.args.event?.metadata?.["strands.orchestrator.id"] ===
          "inner-graph",
    );

    expect(innerGraphSpan?.args.parentSpanIds).toEqual({
      rootSpanId: nodeSpan?.rootSpanId,
      spanId: nodeSpan?.spanId,
    });
    expect(nodeSpan?.end).toHaveBeenCalledTimes(1);
  });

  it("ends open child spans when a stream errors", async () => {
    const plugin = new StrandsAgentSDKPlugin();
    plugin.enable();

    const handlers = handlersByName.get(
      "orchestrion:@strands-agents/sdk:Agent.stream",
    );
    const model = { getConfig: () => ({ modelId: "gpt-4o-mini" }) };
    const stream = (async function* () {
      yield { model, type: "beforeModelCallEvent" };
      throw new Error("stream failed");
    })();
    const event = {
      arguments: ["hello", undefined],
      result: stream,
      self: { model, stream: vi.fn() },
    };

    handlers.start(event);
    handlers.end(event);

    await expect(consume(stream)).rejects.toThrow("stream failed");

    const rootSpan = spans.find((span) => span.args.name === "Strands Agent");
    const modelSpan = spans.find(
      (span) => span.args.name === "Strands model: gpt-4o-mini",
    );
    expect(modelSpan?.end).toHaveBeenCalledTimes(1);
    expect(rootSpan?.log).toHaveBeenCalledWith(
      expect.objectContaining({ error: "stream failed" }),
    );
    expect(rootSpan?.end).toHaveBeenCalledTimes(1);
  });
});

async function* makeAgentStream(events: unknown[], beforeYield?: () => void) {
  for (const event of events) {
    beforeYield?.();
    yield event as never;
  }
  return {
    lastMessage: { role: "assistant", content: [{ text: "done" }] },
    stopReason: "end_turn",
  };
}

async function* makeMultiAgentStream(events: unknown[]) {
  for (const event of events) {
    yield event as never;
  }
  return { content: [{ text: "done" }], status: "COMPLETED" };
}

async function consume(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // consume stream
  }
}
