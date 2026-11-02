import { beforeAll, describe, expect, it } from "vite-plus/test";
import { registerLangChainInstrumentation } from "./langchain-instrumentation";
import { langChainChannels } from "./langchain-interceptors";

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
    registerLangChainInstrumentation();
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
