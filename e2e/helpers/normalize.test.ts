import { describe, expect, test } from "vite-plus/test";
import { normalizeForSnapshot } from "./normalize";

describe("normalizeForSnapshot", () => {
  test("preserves large inline media without scanning it as a repository path", () => {
    const media = `data:image/png;base64,${"a".repeat(3_000_000)}`;
    expect(normalizeForSnapshot(media)).toBe(media);
  });
  test("normalizes a foreign repository path ending at a workspace directory", () => {
    expect(
      normalizeForSnapshot(
        "find /another/checkout/braintrust-sdk-javascript/e2e -name AGENTS.md",
      ),
    ).toBe("find <repo>/e2e -name AGENTS.md");
  });
});
