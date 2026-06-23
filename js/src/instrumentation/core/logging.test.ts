import { describe, expect, it } from "vitest";
import { toLoggedError } from "./logging";

describe("toLoggedError", () => {
  it("returns Error messages", () => {
    expect(toLoggedError(new Error("failed"))).toBe("failed");
  });

  it("preserves string throws", () => {
    expect(toLoggedError("failed")).toBe("failed");
  });

  it("serializes non-Error thrown values", () => {
    expect(toLoggedError({ code: "bad_request" })).toBe(
      '{"code":"bad_request"}',
    );
  });

  it("falls back when non-Error thrown values are not JSON serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(toLoggedError(circular)).toBe("[object Object]");
  });
});
