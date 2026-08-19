import { describe, expect, it } from "vitest";
import * as instrumentation from "./index";

describe("instrumentation public API", () => {
  it("exposes only the curated instrumentation APIs", () => {
    expect(Object.keys(instrumentation).sort()).toEqual([
      "OpenAIAgentsTraceProcessor",
      "braintrustEveHook",
      "braintrustEveInstrumentation",
      "braintrustFlueInstrumentation",
      "braintrustFlueObserver",
      "configureInstrumentation",
    ]);
  });
});
