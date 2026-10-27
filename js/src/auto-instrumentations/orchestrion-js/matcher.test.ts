import { describe, expect, it } from "vitest";
import { InstrumentationMatcher } from "./matcher";

describe("InstrumentationMatcher", () => {
  const matcher = new InstrumentationMatcher([
    {
      channelName: "request",
      module: {
        name: "example",
        versionRange: ">=1.0.0",
        filePath: "dist/src-*.mjs",
      },
      functionQuery: { className: "Client", methodName: "request" },
    },
    {
      channelName: "exact",
      module: {
        name: "example",
        versionRange: ">=1.0.0",
        filePath: "dist/index.mjs",
      },
      functionQuery: { functionName: "exact" },
    },
  ]);

  it("matches content-hashed chunks with a file path pattern", () => {
    expect(
      matcher.getTransformer("example", "1.2.0", "dist/src-DdvbAHrR.mjs"),
    ).toBeDefined();
    expect(
      matcher.getTransformer("example", "1.2.0", "dist\\src-BvE2_t-z.mjs"),
    ).toBeDefined();
  });

  it("keeps patterns within one path segment and file extension", () => {
    expect(
      matcher.getTransformer("example", "1.2.0", "dist/src-abc/index.mjs"),
    ).toBeUndefined();
    expect(
      matcher.getTransformer("example", "1.2.0", "dist/src-DdvbAHrR.cjs"),
    ).toBeUndefined();
    expect(
      matcher.getTransformer("example", "1.2.0", "dist/src-DdvbAHrRxmjs"),
    ).toBeUndefined();
    expect(
      matcher.getTransformer("example", "0.9.0", "dist/src-DdvbAHrR.mjs"),
    ).toBeUndefined();
  });

  it("matches file paths without a pattern exactly", () => {
    expect(
      matcher.getTransformer("example", "1.2.0", "dist/index.mjs"),
    ).toBeDefined();
    expect(
      matcher.getTransformer("example", "1.2.0", "dist/index.mjs.map"),
    ).toBeUndefined();
  });
});
