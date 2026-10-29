import { describe, expect, it } from "vite-plus/test";
import * as instrumentation from "./index";

describe("instrumentation public API", () => {
  it("exposes only the curated instrumentation APIs", () => {
    expect(Object.keys(instrumentation).sort()).toEqual([
      "OpenAIAgentsTraceProcessor",
      "braintrustEveInstrumentation",
      "braintrustFlueInstrumentation",
      "configureInstrumentation",
      "registerOtelFlush",
    ]);
  });
});
