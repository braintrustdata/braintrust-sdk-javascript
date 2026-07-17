import { afterEach, describe, expect, it, vi } from "vitest";

import iso from "./isomorph";
import {
  detectSpanOriginEnvironment,
  mergeSpanOriginContext,
} from "./span-origin";

const originalGetEnv = iso.getEnv;

afterEach(() => {
  iso.getEnv = originalGetEnv;
  vi.restoreAllMocks();
});

describe("mergeSpanOriginContext", () => {
  it("uses the test fallback SDK version when no build-time version is defined", () => {
    const context = mergeSpanOriginContext(undefined, "test-instrumentation");

    expect(context.span_origin).toMatchObject({
      name: "braintrust.sdk.javascript",
      version: "0.0.0",
      instrumentation: { name: "test-instrumentation" },
    });
  });
});

describe("detectSpanOriginEnvironment", () => {
  it("uses production NODE_ENV as a server environment", () => {
    vi.spyOn(iso, "getEnv").mockImplementation((name) =>
      name === "NODE_ENV" ? "production" : undefined,
    );

    expect(detectSpanOriginEnvironment()).toEqual({
      type: "server",
      name: "production",
    });
  });

  it("uses development NODE_ENV as a local environment", () => {
    vi.spyOn(iso, "getEnv").mockImplementation((name) =>
      name === "NODE_ENV" ? "development" : undefined,
    );

    expect(detectSpanOriginEnvironment()).toEqual({
      type: "local",
      name: "development",
    });
  });

  it("preserves custom NODE_ENV values as environment names", () => {
    vi.spyOn(iso, "getEnv").mockImplementation((name) =>
      name === "NODE_ENV" ? "preview" : undefined,
    );

    expect(detectSpanOriginEnvironment()).toEqual({ name: "preview" });
  });
});
