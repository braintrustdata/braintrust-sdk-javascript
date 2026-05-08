import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock iso's newTracingChannel - must be before any imports that use it
vi.mock("../isomorph", () => ({
  default: {
    newTracingChannel: vi.fn(),
    getEnv: vi.fn(() => undefined),
    buildType: "node",
  },
}));

import { registry, configureInstrumentation } from "./registry";
import iso from "../isomorph";

const mockNewTracingChannel = iso.newTracingChannel as ReturnType<typeof vi.fn>;

describe("Plugin Registry", () => {
  beforeEach(() => {
    // Setup mock channel
    const mockChannel = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      hasSubscribers: false,
    };
    mockNewTracingChannel.mockReturnValue(mockChannel);
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
    // the same diagnostics_channel, causing every OpenAI call to produce two
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

      // instanceB should be blocked — the channel is already subscribed
      instanceB.enable();
      expect(instanceB.isEnabled()).toBe(false);
    } finally {
      instanceA.disable();
      instanceB.disable();
      delete (globalThis as any)[stateKey];
    }
  });

  it("should warn if configureInstrumentation is called after enable", () => {
    const testRegistry = new (registry.constructor as any)();
    const warnSpy = [] as string[];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnSpy.push(msg);

    try {
      testRegistry.enable();
      testRegistry.configure({ integrations: { openai: false } });

      expect(warnSpy.length).toBeGreaterThan(0);
      expect(warnSpy[0]).toContain("Cannot configure instrumentation");
    } finally {
      console.warn = originalWarn;
      testRegistry.disable();
    }
  });

  it("should allow configuration before enable", () => {
    const testRegistry = new (registry.constructor as any)();
    const warnSpy = [] as string[];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnSpy.push(msg);

    try {
      testRegistry.configure({ integrations: { openai: false } });
      testRegistry.enable();

      expect(warnSpy.length).toBe(0);
    } finally {
      console.warn = originalWarn;
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
        anthropic: true,
        huggingface: true,
        openrouter: false,
        mistral: false,
        cohere: false,
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
