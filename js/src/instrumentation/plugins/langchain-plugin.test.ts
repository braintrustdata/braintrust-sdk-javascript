import * as diagnosticsChannel from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import iso from "../../isomorph";
import { LangChainPlugin } from "./langchain-plugin";
import { langChainChannels } from "./langchain-channels";

iso.newTracingChannel = <M = unknown>(nameOrChannels: string | object) =>
  diagnosticsChannel.tracingChannel(
    nameOrChannels as string,
  ) as never as ReturnType<typeof iso.newTracingChannel<M>>;

function createManager(handlers: unknown[] = []) {
  return {
    handlers,
    addHandler(handler: unknown) {
      this.handlers.push(handler);
    },
  };
}

function traceConfigureResult(result: unknown) {
  return langChainChannels.configure.traceSync(() => result, {
    arguments: [],
  });
}

function traceConfigureArguments(args: unknown[]) {
  return langChainChannels.configure.traceSync(() => args, {
    arguments: args,
  });
}

function traceConfigureArgumentsObject(args: IArguments) {
  return langChainChannels.configure.traceSync(() => args, {
    arguments: args,
  });
}

function createArgumentsObject(...args: unknown[]): IArguments {
  return (function getArgumentsObject() {
    return arguments;
  })(...args);
}

describe("LangChainPlugin", () => {
  it("injects a Braintrust callback handler into empty CallbackManager.configure() arguments", () => {
    const plugin = new LangChainPlugin();
    const args: unknown[] = [];

    plugin.enable();
    traceConfigureArguments(args);
    plugin.disable();

    expect(args[0]).toEqual([
      expect.objectContaining({
        name: "BraintrustCallbackHandler",
      }),
    ]);
  });

  it("injects a Braintrust callback handler into real arguments objects", () => {
    const plugin = new LangChainPlugin();
    const args = createArgumentsObject();

    plugin.enable();
    traceConfigureArgumentsObject(args);
    plugin.disable();

    expect(args[0]).toEqual([
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
