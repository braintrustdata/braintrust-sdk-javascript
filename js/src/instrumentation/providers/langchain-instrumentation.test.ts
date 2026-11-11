import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { langChainChannels } from "./langchain-interceptors";
import { registerLangChainInstrumentation } from "./langchain-instrumentation";
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

describe("registerLangChainInstrumentation", () => {
  beforeAll(() => {
    registerLangChainInstrumentation({
      captureChainInputs: false,
      captureChainOutputs: false,
      captureModelInputs: false,
      captureModelOutputs: false,
      captureModelTokenUsage: false,
    });
  });

  it("injects a Braintrust callback handler into empty CallbackManager.configure() arguments", () => {
    const args: unknown[] = [];

    const received = traceConfigureArguments(args);

    expect(received[0]).toEqual([
      expect.objectContaining({
        name: "BraintrustCallbackHandler",
      }),
    ]);
  });

  it("injects a Braintrust callback handler into real arguments objects", () => {
    const args = createArgumentsObject();

    const received = traceConfigureArgumentsObject(args);

    expect(received[0]).toEqual([
      expect.objectContaining({
        name: "BraintrustCallbackHandler",
      }),
    ]);
  });

  it("injects a Braintrust callback handler into CallbackManager.configure() results", () => {
    const manager = createManager();

    traceConfigureResult(manager);

    expect(manager.handlers).toHaveLength(1);
    expect(manager.handlers[0]).toMatchObject({
      name: "BraintrustCallbackHandler",
    });
  });

  it("does not inject duplicate handlers into the same manager", () => {
    const manager = createManager();

    traceConfigureResult(manager);
    traceConfigureResult(manager);

    expect(manager.handlers).toHaveLength(1);
  });

  it("does not inject when a Braintrust callback handler is already present", () => {
    const existingHandler = { name: "BraintrustCallbackHandler" };
    const manager = createManager([existingHandler]);

    traceConfigureResult(manager);

    expect(manager.handlers).toEqual([existingHandler]);
  });

  it("gracefully ignores undefined and non-manager results", () => {
    expect(() => traceConfigureResult(undefined)).not.toThrow();
    expect(() => traceConfigureResult({ handlers: [] })).not.toThrow();
  });
});

it.each(["arguments", "result"] as const)(
  "applies capture options to the handler injected into %s",
  async (path) => {
    let handler: BraintrustLangChainCallbackHandler;
    {
      if (path === "arguments") {
        handler = traceConfigureArguments([])[0][0];
      } else {
        const manager = createManager();
        traceConfigureResult(manager);
        handler = manager.handlers[0] as BraintrustLangChainCallbackHandler;
      }
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
