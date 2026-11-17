import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import iso from "#braintrust-platform";
import { GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION } from "../global-instrumentation-hooks";
import { configureInstrumentation, registry } from "./registry";

const registryKey = Symbol.for(
  `braintrust.registry.global-hooks.v${GLOBAL_INSTRUMENTATION_HOOKS_PROTOCOL_VERSION}`,
);

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[registryKey];
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<symbol, unknown>)[registryKey];
});

describe("explicit instrumentation registration", () => {
  it("does not register until requested", () => {
    expect(registry.isEnabled()).toBe(false);
  });

  it("deduplicates each provider independently across registry copies", () => {
    const second = new (registry.constructor as new () => typeof registry)();
    const openai = vi.fn();
    const anthropic = vi.fn();
    registry.register("openai", openai);
    second.register("openai", openai);
    second.register("anthropic", anthropic);
    registry.register("anthropic", anthropic);
    expect(openai).toHaveBeenCalledOnce();
    expect(anthropic).toHaveBeenCalledOnce();
  });

  it("handles reentrant registration", () => {
    const subscribe = vi.fn<() => void>();
    subscribe.mockImplementation(() => registry.register("openai", subscribe));
    registry.register("openai", subscribe);
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("shares configuration before registration and merges provider settings", () => {
    configureInstrumentation({ integrations: { openai: false } });
    configureInstrumentation({ integrations: { anthropic: false } });
    const subscribe = vi.fn();
    registry.register("openai", subscribe);
    registry.register("anthropic", subscribe);
    expect(subscribe).not.toHaveBeenCalled();
    registry.register("groq", subscribe);
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("warns when configuration arrives after registration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("openai", () => {});
    configureInstrumentation({ integrations: { openai: false } });
    expect(warn).toHaveBeenCalledWith(
      "[braintrust]",
      expect.stringContaining("Cannot configure"),
    );
  });

  it.each(["openai", " OPENAI , anthropic ", "OpenAI,ai-sdk"])(
    "environment opt-outs override explicit enablement: %s",
    (disabled) => {
      vi.spyOn(iso, "getEnv").mockImplementation((name) =>
        name === "BRAINTRUST_DISABLE_INSTRUMENTATION" ? disabled : undefined,
      );
      configureInstrumentation({ integrations: { openai: true } });
      const subscribe = vi.fn();
      registry.register("openai", subscribe);
      expect(subscribe).not.toHaveBeenCalled();
    },
  );

  it("keeps the combined LangChain/LangGraph opt-out", () => {
    configureInstrumentation({ integrations: { langgraph: false } });
    const subscribe = vi.fn();
    registry.register("langchain", subscribe);
    expect(subscribe).not.toHaveBeenCalled();
  });
});
