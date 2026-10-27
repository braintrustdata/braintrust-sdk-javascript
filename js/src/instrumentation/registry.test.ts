import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newGlobalInvocationHook } from "../global-instrumentation-hooks";
import { debugLogger } from "../debug-logger";
vi.mock("../global-instrumentation-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../global-instrumentation-hooks")>()),
  newGlobalInvocationHook: vi.fn(),
}));

// Mock platform context independently of invocation hooks.
vi.mock("../isomorph", () => ({
  default: {
    newAsyncLocalStorage: vi.fn(() => ({
      getStore: vi.fn(() => undefined),
      run: vi.fn((_store: unknown, callback: () => unknown) => callback()),
    })),
    getEnv: vi.fn(() => undefined),
    buildType: "node",
  },
}));

import { configureInstrumentation, registry } from "./registry";
import { LiveKitPlugin } from "./plugins/livekit-plugin";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[
    Symbol.for("braintrust.instrumentation.config")
  ];
});

const mockNewInvocationHook = newGlobalInvocationHook as ReturnType<
  typeof vi.fn
>;

describe("Plugin Registry", () => {
  beforeEach(() => {
    // Setup mock channel
    const mockChannel = {
      intercept: vi.fn(() => vi.fn()),
      unintercept: vi.fn(() => vi.fn()),
      hasSubscribers: false,
    };
    mockNewInvocationHook.mockReturnValue(mockChannel);
  });

  // Clean up after each test
  afterEach(() => {
    registry.disable();
  });

  it("should not be enabled by default", () => {
    const testRegistry = new (registry.constructor as any)();
    expect(testRegistry.isEnabled()).toBe(false);
  });

  it("should enable plugins when enable() is called", () => {
    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();
    expect(testRegistry.isEnabled()).toBe(true);
    testRegistry.disable();
  });

  it("should be idempotent (calling enable() multiple times)", () => {
    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();
    testRegistry.enable(); // Should not throw
    expect(testRegistry.isEnabled()).toBe(true);
    testRegistry.disable();
  });

  it("should block a second instance from subscribing when another is already enabled", () => {
    // Regression test for BT-5139: when the SDK is loaded from two different
    // module paths in the same process, each gets its own PluginRegistry
    // instance. Without cross-instance deduplication, both would subscribe to
    // the same global hook, causing every OpenAI call to produce two
    // LLM spans.
    //
    // The dedup mechanism checks globalThis[Symbol.for("braintrust-state")],
    // which is the shared state object that all SDK instances reuse (see
    // _internalSetInitialState in logger.ts). We simulate that here.
    const sharedState = {};
    const stateKey = Symbol.for("braintrust-state");
    (globalThis as any)[stateKey] = sharedState;

    const instanceA = new (registry.constructor as any)();
    const instanceB = new (registry.constructor as any)();

    try {
      instanceA.enable();
      expect(instanceA.isEnabled()).toBe(true);

      // instanceB should be blocked — the hook is already subscribed
      instanceB.enable();
      expect(instanceB.isEnabled()).toBe(false);
    } finally {
      instanceA.disable();
      instanceB.disable();
      delete (globalThis as any)[stateKey];
    }
  });

  it("should ignore deduplication markers from older transports", () => {
    const stateKey = Symbol.for("braintrust-state");
    (globalThis as any)[stateKey] = {
      [Symbol.for("braintrust.registry")]: {},
    };
    const testRegistry = new (registry.constructor as any)();

    try {
      testRegistry.enable();
      expect(testRegistry.isEnabled()).toBe(true);
    } finally {
      testRegistry.disable();
      delete (globalThis as any)[stateKey];
    }
  });

  it("should warn if configureInstrumentation is called after enable", () => {
    const testRegistry = new (registry.constructor as any)();
    const warnSpy = vi
      .spyOn(debugLogger.notice, "warn")
      .mockImplementation(() => true);

    try {
      testRegistry.enable();
      testRegistry.configure({ integrations: { openai: false } });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cannot configure instrumentation"),
      );
    } finally {
      warnSpy.mockRestore();
      testRegistry.disable();
    }
  });

  it("shares startup integration settings with a separately bundled registry", () => {
    const bootstrap = new (registry.constructor as any)();
    const sdk = new (registry.constructor as any)();
    bootstrap.configure({ integrations: { openai: false, livekit: false } });
    mockNewInvocationHook.mockClear();
    try {
      sdk.enable();
      const names = mockNewInvocationHook.mock.calls.map(([name]) => name);
      expect(names.some((name) => name.startsWith("orchestrion:openai:"))).toBe(
        false,
      );
      expect(
        names.some((name) => name.startsWith("orchestrion:@livekit/agents:")),
      ).toBe(false);
      expect(
        names.some((name) => name.startsWith("orchestrion:@anthropic-ai/sdk:")),
      ).toBe(true);
    } finally {
      sdk.disable();
    }
  });

  it.each([undefined, 8192])(
    "passes the %s-byte threshold from a separately bundled registry to LiveKit",
    (streamingAttachmentBufferBytes) => {
      const bootstrap = new (registry.constructor as any)();
      const sdk = new (registry.constructor as any)();
      const thresholds: number[] = [];
      const enable = vi
        .spyOn(LiveKitPlugin.prototype, "enable")
        .mockImplementation(function (this: LiveKitPlugin) {
          thresholds.push(Reflect.get(this, "streamingAttachmentBufferBytes"));
        });
      try {
        bootstrap.configure({ streamingAttachmentBufferBytes });
        // A later integration-only update must preserve the shared threshold.
        sdk.configure({ integrations: { openai: false } });
        sdk.enable();
        expect(thresholds).toEqual([
          streamingAttachmentBufferBytes ?? 4 * 1024 * 1024,
        ]);
      } finally {
        sdk.disable();
        enable.mockRestore();
      }
    },
  );

  it.each([0, 1.5])(
    "rejects an invalid threshold (%s) without changing startup settings",
    (streamingAttachmentBufferBytes) => {
      const testRegistry = new (registry.constructor as any)();
      testRegistry.configure({ streamingAttachmentBufferBytes: 1024 });
      expect(() =>
        testRegistry.configure({ streamingAttachmentBufferBytes }),
      ).toThrow(
        "streamingAttachmentBufferBytes must be a positive safe integer",
      );
      expect(
        Reflect.get(
          globalThis,
          Symbol.for("braintrust.instrumentation.config"),
        ),
      ).toMatchObject({
        streamingAttachmentBufferBytes: 1024,
      });
    },
  );

  it("LiveKit options keep it enabled and pass audio settings across bundles", () => {
    const bootstrap = new (registry.constructor as any)();
    const sdk = new (registry.constructor as any)();
    const audio = { codec: { name: "pcm" } };
    const received: unknown[] = [];
    const enable = vi
      .spyOn(LiveKitPlugin.prototype, "enable")
      .mockImplementation(function (this: LiveKitPlugin) {
        received.push(Reflect.get(this, "audio"));
      });
    try {
      bootstrap.configure({ integrations: { livekit: { audio } } });
      sdk.enable();
      expect(received).toEqual([audio]);
    } finally {
      sdk.disable();
      enable.mockRestore();
    }
  });

  it("should allow configuration before enable", () => {
    const testRegistry = new (registry.constructor as any)();
    const warnSpy = vi
      .spyOn(debugLogger.notice, "warn")
      .mockImplementation(() => true);

    try {
      testRegistry.configure({ integrations: { openai: false } });
      testRegistry.enable();

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      testRegistry.disable();
    }
  });

  it("should disable plugins when disable() is called", () => {
    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();
    expect(testRegistry.isEnabled()).toBe(true);

    testRegistry.disable();
    expect(testRegistry.isEnabled()).toBe(false);
  });

  it("should be idempotent (calling disable() multiple times)", () => {
    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();
    testRegistry.disable();
    testRegistry.disable(); // Should not throw
    expect(testRegistry.isEnabled()).toBe(false);
  });
});

describe("configureInstrumentation API", () => {
  afterEach(() => {
    registry.disable();
  });

  it("should export configureInstrumentation function", () => {
    expect(typeof configureInstrumentation).toBe("function");
  });

  it("should accept integration configuration", () => {
    // Should not throw
    configureInstrumentation({
      integrations: {
        openai: false,
        openaiCodexSDK: false,
        anthropic: true,
        huggingface: true,
        openrouter: false,
        mistral: false,
        cohere: false,
        mastra: false,
        strandsAgentSDK: false,
        cloudflareAIChat: false,
        cloudflareAgents: false,
      },
    });
  });
});

describe("Environment Variable Configuration", () => {
  let originalGetEnv: typeof import("../isomorph").default.getEnv;

  beforeEach(async () => {
    const iso = (await import("../isomorph")).default;
    originalGetEnv = iso.getEnv;
  });

  afterEach(async () => {
    const iso = (await import("../isomorph")).default;
    iso.getEnv = originalGetEnv;
    registry.disable();
  });

  it("should parse BRAINTRUST_DISABLE_INSTRUMENTATION with single SDK", async () => {
    const iso = (await import("../isomorph")).default;
    iso.getEnv = (name: string) => {
      if (name === "BRAINTRUST_DISABLE_INSTRUMENTATION") {
        return "openai";
      }
      return originalGetEnv(name);
    };

    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();

    // OpenAI should be disabled, others enabled by default
    expect(testRegistry.isEnabled()).toBe(true);
    testRegistry.disable();
  });

  it("BRAINTRUST_DISABLE_INSTRUMENTATION disables LiveKit configured with options", async () => {
    const iso = (await import("../isomorph")).default;
    iso.getEnv = (name: string) =>
      name === "BRAINTRUST_DISABLE_INSTRUMENTATION"
        ? "livekit"
        : originalGetEnv(name);
    const enable = vi.spyOn(LiveKitPlugin.prototype, "enable");
    const testRegistry = new (registry.constructor as any)();
    try {
      testRegistry.configure({
        integrations: { livekit: { audio: { codec: { name: "pcm" } } } },
      });
      testRegistry.enable();
      expect(enable).not.toHaveBeenCalled();
    } finally {
      testRegistry.disable();
      enable.mockRestore();
    }
  });

  it("should parse BRAINTRUST_DISABLE_INSTRUMENTATION with multiple SDKs", async () => {
    const iso = (await import("../isomorph")).default;
    iso.getEnv = (name: string) => {
      if (name === "BRAINTRUST_DISABLE_INSTRUMENTATION") {
        return "openai,anthropic";
      }
      return originalGetEnv(name);
    };

    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();

    // Both should be disabled
    expect(testRegistry.isEnabled()).toBe(true);
    testRegistry.disable();
  });

  it("should handle whitespace in BRAINTRUST_DISABLE_INSTRUMENTATION", async () => {
    const iso = (await import("../isomorph")).default;
    iso.getEnv = (name: string) => {
      if (name === "BRAINTRUST_DISABLE_INSTRUMENTATION") {
        return " openai , anthropic , vercel ";
      }
      return originalGetEnv(name);
    };

    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();

    expect(testRegistry.isEnabled()).toBe(true);
    testRegistry.disable();
  });

  it("should handle empty BRAINTRUST_DISABLE_INSTRUMENTATION", async () => {
    const iso = (await import("../isomorph")).default;
    iso.getEnv = (name: string) => {
      if (name === "BRAINTRUST_DISABLE_INSTRUMENTATION") {
        return "";
      }
      return originalGetEnv(name);
    };

    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();

    // All should be enabled (nothing disabled)
    expect(testRegistry.isEnabled()).toBe(true);
    testRegistry.disable();
  });

  it("should be case-insensitive for SDK names", async () => {
    const iso = (await import("../isomorph")).default;
    iso.getEnv = (name: string) => {
      if (name === "BRAINTRUST_DISABLE_INSTRUMENTATION") {
        return "OpenAI,ANTHROPIC";
      }
      return originalGetEnv(name);
    };

    const testRegistry = new (registry.constructor as any)();
    testRegistry.enable();

    expect(testRegistry.isEnabled()).toBe(true);
    testRegistry.disable();
  });
});
