import { afterEach, describe, expect, it, vi } from "vitest";

import iso from "./isomorph";
import {
  detectSpanOriginEnvironment,
  getSpanInstrumentationName,
  INSTRUMENTATION_NAMES,
  INTERNAL_SPAN_INSTRUMENTATION_NAME,
  mergeSpanOriginContext,
  withSpanInstrumentationName,
} from "./span-origin";

const originalGetEnv = iso.getEnv;

afterEach(() => {
  iso.getEnv = originalGetEnv;
  vi.restoreAllMocks();
});

describe("mergeSpanOriginContext", () => {
  it("uses the test fallback SDK version when no build-time version is defined", () => {
    const context = mergeSpanOriginContext(
      undefined,
      INSTRUMENTATION_NAMES.OPENAI,
    );

    expect(context.span_origin).toMatchObject({
      name: "braintrust.sdk.javascript",
      version: "0.0.0",
      instrumentation: { name: INSTRUMENTATION_NAMES.OPENAI },
    });
  });

  it("carries an internal instrumentation name without changing public span args", () => {
    const args = withSpanInstrumentationName(
      { name: "test-span" },
      INSTRUMENTATION_NAMES.OPENAI,
    );

    expect(args.name).toBe("test-span");
    expect(getSpanInstrumentationName(args)).toBe(INSTRUMENTATION_NAMES.OPENAI);
    expect(getSpanInstrumentationName({ name: "test-span" })).toBeUndefined();
  });

  it("rejects instrumentation names outside the internal catalog", () => {
    expect(
      getSpanInstrumentationName({
        [INTERNAL_SPAN_INSTRUMENTATION_NAME]: "arbitrary-instrumentation",
      }),
    ).toBeUndefined();
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
