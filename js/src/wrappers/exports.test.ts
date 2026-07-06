import { describe, it, expect } from "vitest";
import { BraintrustMiddleware } from "./ai-sdk";

describe("ai-sdk exports", () => {
  it("should always export BraintrustMiddleware as a function", () => {
    expect(typeof BraintrustMiddleware).toBe("function");
  });

  it("BraintrustMiddleware should return an object with wrapGenerate and wrapStream", () => {
    const result = BraintrustMiddleware({});
    expect(result).toHaveProperty("wrapGenerate");
    expect(result).toHaveProperty("wrapStream");
    expect(typeof result.wrapGenerate).toBe("function");
    expect(typeof result.wrapStream).toBe("function");
  });

  it("should handle conditional imports gracefully", () => {
    // Test that imports don't throw errors regardless of AI SDK version
    expect(() => {
      const middleware = BraintrustMiddleware({ debug: true });

      // Should be able to call the functions without errors
      const { wrapGenerate, wrapStream } = middleware;

      expect(wrapGenerate).toBeDefined();
      expect(wrapStream).toBeDefined();
    }).not.toThrow();
  });

  it("should export middleware functions that can be instantiated", () => {
    const middleware = BraintrustMiddleware({});
    const { wrapGenerate, wrapStream } = middleware;

    // Should be functions that can be called (we don't test actual execution due to logger dependencies)
    expect(typeof wrapGenerate).toBe("function");
    expect(typeof wrapStream).toBe("function");
  });
});
