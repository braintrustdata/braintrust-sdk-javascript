import { describe, expect, it, vi } from "vitest";
import { langChainChannels } from "./langchain-interceptors";
import { LangChainPlugin } from "./langchain-plugin";
import type {
  LangChainStartSpanArgs,
  LangChainEndSpanArgs,
} from "../../vendor-sdk-types/langchain";
import { BraintrustLangChainCallbackHandler } from "../../wrappers/langchain/callback-handler";

function createManager(handlers: unknown[] = []) {
  return {
    handlers,
    addHandler(handler: unknown) {
      this.handlers.push(handler);
    },
  };
}

function traceConfigureResult(result: unknown) {
  return langChainChannels.configure.invoke(
    () => result as any,
    undefined,
    [],
    {},
  );
}
function traceConfigureArguments(args: unknown[]) {
  return langChainChannels.configure.invoke(
    (...received: unknown[]) => received as any,
    undefined,
    args as any,
    {},
  );
}
function traceConfigureArgumentsObject(args: IArguments) {
  return langChainChannels.configure.invoke(
    function (..._received: unknown[]) {
      return arguments as any;
    },
    undefined,
    args as any,
    {},
  );
}

function createArgumentsObject(...args: unknown[]): IArguments {
  return (function getArgumentsObject(..._args: unknown[]) {
    return arguments;
  })(...args);
}

describe("LangChainPlugin", () => {
  it("injects a Braintrust callback handler into empty CallbackManager.configure() arguments", () => {
    const plugin = new LangChainPlugin();
    const args: unknown[] = [];

    plugin.enable();
    const received = traceConfigureArguments(args);
    plugin.disable();

    expect(received[0]).toEqual([
      expect.objectContaining({
        name: "BraintrustCallbackHandler",
      }),
    ]);
  });

  it("injects a Braintrust callback handler into real arguments objects", () => {
    const plugin = new LangChainPlugin();
    const args = createArgumentsObject();

    plugin.enable();
    const received = traceConfigureArgumentsObject(args);
    plugin.disable();

    expect(received[0]).toEqual([
      expect.objectContaining({
        name: "BraintrustCallbackHandler",
      }),
    ]);
  });

  it("injects a Braintrust callback handler into CallbackManager.configure() results", () => {
    const plugin = new LangChainPlugin();
    const manager = createManager();

    plugin.enable();
    traceConfigureResult(manager);
    plugin.disable();

    expect(manager.handlers).toHaveLength(1);
    expect(manager.handlers[0]).toMatchObject({
      name: "BraintrustCallbackHandler",
    });
  });

  it("does not inject duplicate handlers into the same manager", () => {
    const plugin = new LangChainPlugin();
    const manager = createManager();

    plugin.enable();
    traceConfigureResult(manager);
    traceConfigureResult(manager);
    plugin.disable();

    expect(manager.handlers).toHaveLength(1);
  });

  it("does not inject when a Braintrust callback handler is already present", () => {
    const plugin = new LangChainPlugin();
    const existingHandler = { name: "BraintrustCallbackHandler" };
    const manager = createManager([existingHandler]);

    plugin.enable();
    traceConfigureResult(manager);
    plugin.disable();

    expect(manager.handlers).toEqual([existingHandler]);
  });

  it("gracefully ignores undefined and non-manager results", () => {
    const plugin = new LangChainPlugin();

    plugin.enable();

    expect(() => traceConfigureResult(undefined)).not.toThrow();
    expect(() => traceConfigureResult({ handlers: [] })).not.toThrow();

    plugin.disable();
  });
});

it.each(["arguments", "result"] as const)(
  "applies capture options to the handler injected into %s",
  async (path) => {
    const plugin = new LangChainPlugin({
      captureChainInputs: false,
      captureChainOutputs: false,
      captureModelInputs: false,
      captureModelOutputs: false,
      captureModelTokenUsage: false,
    });
    plugin.enable();
    let handler: BraintrustLangChainCallbackHandler;
    try {
      if (path === "arguments") {
        handler = traceConfigureArguments([])[0][0];
      } else {
        const manager = createManager();
        traceConfigureResult(manager);
        handler = manager.handlers[0] as BraintrustLangChainCallbackHandler;
      }
    } finally {
      plugin.disable();
    }
    // Observe the boundary before any logger copying happens.
    const boundary = handler as unknown as {
      startSpan(args: LangChainStartSpanArgs): void;
      endSpan(args: LangChainEndSpanArgs): void;
    };
    const start = vi.spyOn(boundary, "startSpan").mockImplementation(() => {});
    const end = vi.spyOn(boundary, "endSpan").mockImplementation(() => {});
    await handler.handleChainStart({}, { state: "input" }, "chain");
    await handler.handleChainEnd({ state: "output" }, "chain");
    await handler.handleChatModelStart({}, [[{ content: "hello" }]], "model");
    await handler.handleLLMEnd(
      { llmOutput: { tokenUsage: { totalTokens: 10 } } },
      "model",
    );
    for (const [args] of start.mock.calls) {
      expect(args).not.toHaveProperty("event.input");
    }
    for (const [args] of end.mock.calls) {
      expect(args).not.toHaveProperty("output");
      expect(args).not.toHaveProperty("metrics.tokens");
    }
    expect(start).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(2);
  },
);
