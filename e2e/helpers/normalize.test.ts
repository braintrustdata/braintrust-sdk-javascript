import { describe, expect, test } from "vitest";
import { normalizeForSnapshot } from "./normalize";

describe("normalizeForSnapshot", () => {
  test("normalizes a foreign repository path ending at a workspace directory", () => {
    expect(
      normalizeForSnapshot(
        "find /another/checkout/braintrust-sdk-javascript/e2e -name AGENTS.md",
      ),
    ).toBe("find <repo>/e2e -name AGENTS.md");
  });
});
