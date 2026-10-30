import { transform } from "esbuild";
import { runInNewContext } from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorSDKConfigs } from "../../src/auto-instrumentations/configs/cursor-sdk";
import { InstrumentationMatcher } from "../../src/auto-instrumentations/orchestrion-js";
import {
  GLOBAL_INSTRUMENTATION_HOOKS_KEY,
  newGlobalInvocationHook,
} from "../../src/global-instrumentation-hooks";

const { spans } = vi.hoisted(() => ({ spans: [] as any[] }));
vi.mock("../../src/isomorph", () => ({
  default: { newAsyncLocalStorage: <T>() => new AsyncLocalStorage<T>() },
}));
vi.mock("../../src/logger", () => ({
  startSpan: (args: any) => {
    const span = {
      ...args,
      log: vi.fn(),
      end: vi.fn(),
      export: async () => args.name,
    };
    spans.push(span);
    return span;
  },
  withCurrent: (_span: unknown, call: () => unknown) => call(),
}));
import { CursorSDKPlugin } from "../../src/instrumentation/plugins/cursor-sdk-plugin";

// Cursor ships synchronous methods returning promises and minified class names.
const source = `
  class Unrelated { static create() { return "unrelated"; } }
  export class Agent {
    static #prefix = "agent";
    static create(options) { return Promise.resolve({ id: this.#prefix, options }); }
    static resume(id, options) { return Promise.resolve({ id, options }); }
    static prompt(message, options) { return Promise.resolve({ result: message, options }); }
    static list() { return Promise.resolve(["untouched"]); }
  }
  export const unrelated = Unrelated.create();
`;

describe("Cursor SDK automatic transforms", () => {
  const remove: Array<() => void> = [];
  const plugin = new CursorSDKPlugin();
  beforeEach(() => {
    spans.length = 0;
    plugin.enable();
  });
  afterEach(() => {
    plugin.disable();
    for (const unsubscribe of remove.splice(0)) unsubscribe();
  });
  it.each(["esm", "cjs"] as const)(
    "instruments the minified %s public API and preserves behavior",
    async (format) => {
      const built = await transform(source, {
        format,
        minify: true,
        target: "es2022",
      });
      const matcher = new InstrumentationMatcher(cursorSDKConfigs);
      const transformer = matcher.getTransformer(
        "@cursor/sdk",
        "1.0.12",
        `dist/${format}/index.js`,
      )!;
      const instrumented = transformer.transform(built.code, format);
      const calls: Array<{
        operation: string;
        receiver: unknown;
        args: unknown[];
      }> = [];
      for (const operation of ["create", "resume", "prompt"]) {
        const hook = newGlobalInvocationHook(
          `orchestrion:@cursor/sdk:Agent.${operation}`,
        );
        remove.push(
          hook.intercept((target, receiver, args) => {
            calls.push({ operation, receiver, args });
            return Reflect.apply(target, receiver, args);
          }),
        );
      }
      const executable =
        format === "esm"
          ? (await transform(instrumented.code, { format: "cjs" })).code
          : instrumented.code;
      const module = { exports: {} as any };
      runInNewContext(executable, {
        module,
        exports: module.exports,
        [GLOBAL_INSTRUMENTATION_HOOKS_KEY]: (globalThis as any)[
          GLOBAL_INSTRUMENTATION_HOOKS_KEY
        ],
        Map,
        Symbol,
        Promise,
      });
      const { Agent, unrelated } = module.exports;
      const options = { local: { cwd: "/tmp" } };
      expect(await Agent.create(options)).toEqual({ id: "agent", options });
      expect(await Agent.resume("existing", options)).toEqual({
        id: "existing",
        options,
      });
      expect(await Agent.prompt("hello", options)).toEqual({
        result: "hello",
        options,
      });
      expect(await Agent.list()).toEqual(["untouched"]);
      expect(unrelated).toBe("unrelated");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: "Cursor Agent",
        spanAttributes: { type: "task" },
      });
      expect(spans[0].log).toHaveBeenCalledWith(
        expect.objectContaining({ output: "hello" }),
      );
      expect(spans[0].end).toHaveBeenCalledOnce();
      expect(calls.map((call) => call.operation)).toEqual([
        "create",
        "resume",
        "prompt",
      ]);
      expect(calls.every((call) => call.receiver === Agent)).toBe(true);
      expect(calls[0].args[0]).toBe(options);
      for (const unsubscribe of remove.splice(0)) unsubscribe();
      plugin.disable();
      expect(await Agent.prompt("disabled", options)).toEqual({
        result: "disabled",
        options,
      });
      expect(calls).toHaveLength(3);
      expect(spans).toHaveLength(1);
    },
  );
});
