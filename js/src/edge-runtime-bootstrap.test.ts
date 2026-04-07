import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type EdgeEntrypoint = "./edge-light/index" | "./workerd/index";
const braintrustStateSymbol = Symbol.for("braintrust-state");

describe.each([
  ["./workerd/index", "workerd"],
  ["./edge-light/index", "edge-light"],
] satisfies ReadonlyArray<readonly [EdgeEntrypoint, string]>)(
  "%s AsyncLocalStorage bootstrap",
  (entrypoint, projectName) => {
    const originalAsyncLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "AsyncLocalStorage",
    );
    const originalGetBuiltinModuleDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "getBuiltinModule",
    );

    function restoreRuntimeEnvironment() {
      vi.resetModules();
      vi.restoreAllMocks();

      Reflect.deleteProperty(globalThis, braintrustStateSymbol);

      if (originalAsyncLocalStorageDescriptor) {
        Object.defineProperty(
          globalThis,
          "AsyncLocalStorage",
          originalAsyncLocalStorageDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, "AsyncLocalStorage");
      }

      if (originalGetBuiltinModuleDescriptor) {
        Object.defineProperty(
          process,
          "getBuiltinModule",
          originalGetBuiltinModuleDescriptor,
        );
      } else {
        Reflect.deleteProperty(process, "getBuiltinModule");
      }
    }

    beforeEach(() => {
      restoreRuntimeEnvironment();
    });

    afterEach(() => {
      restoreRuntimeEnvironment();
    });

    test("falls back to node:async_hooks when AsyncLocalStorage is not global", async () => {
      Reflect.deleteProperty(globalThis, "AsyncLocalStorage");

      const asyncHooksModule = await import("node:async_hooks");
      const getBuiltinModule = vi.fn((id: string) =>
        id === "node:async_hooks" ? asyncHooksModule : undefined,
      );

      Object.defineProperty(process, "getBuiltinModule", {
        configurable: true,
        get: () => getBuiltinModule,
      });

      const braintrust = await import(entrypoint);

      braintrust._exportsForTestingOnly.setInitialTestState();
      await braintrust._exportsForTestingOnly.simulateLoginForTests();

      const backgroundLogger =
        braintrust._exportsForTestingOnly.useTestBackgroundLogger();
      const logger = braintrust.initLogger({
        projectId: "test-project-id",
        projectName,
      });

      const root = logger.startSpan({ name: "root", type: "task" });
      const parent = await root.export();

      const result = await braintrust.traced(
        async (span: unknown) => {
          const active = braintrust.currentSpan();
          const child = braintrust.startSpan({ name: "child", type: "task" });

          child.end();

          return {
            childParents: child.spanParents,
            childRootSpanId: child.rootSpanId,
            isNoop: Object.is(active, braintrust.NOOP_SPAN),
            sameObject: Object.is(active, span),
          };
        },
        { parent, name: "chat", type: "task" },
      );

      root.end();
      await logger.flush();

      expect(getBuiltinModule).toHaveBeenCalledWith("node:async_hooks");
      expect(result.isNoop).toBe(false);
      expect(result.sameObject).toBe(true);
      expect(result.childParents).toHaveLength(1);
      expect(result.childRootSpanId).toBe(root.spanId);
      expect(await backgroundLogger.drain()).toHaveLength(3);
    });

    test("wrapAISDK logs spans in edge runtimes", async () => {
      const braintrust = await import(entrypoint);

      braintrust._exportsForTestingOnly.setInitialTestState();
      await braintrust._exportsForTestingOnly.simulateLoginForTests();

      const backgroundLogger =
        braintrust._exportsForTestingOnly.useTestBackgroundLogger();
      braintrust.initLogger({
        projectId: "test-project-id",
        projectName,
      });

      await braintrust.traced(async () => "ok", { name: "root" });

      const wrapped = braintrust.wrapAISDK({
        generateText: async () => ({
          finishReason: "stop",
          text: "ok",
          usage: {
            completionTokens: 1,
            promptTokens: 1,
            totalTokens: 2,
          },
        }),
      });

      await wrapped.generateText({
        model: { modelId: "fake-model", provider: "fake-provider" },
        prompt: "hello",
      });

      const spans = await backgroundLogger.drain();
      const spanNames = spans.map((span) => span.span_attributes?.name);

      expect(spanNames).toContain("root");
      expect(spanNames).toContain("generateText");
    });
  },
);
