import { describe, expect, test } from "vitest";
import { normalizeForSnapshot } from "./normalize";

describe("normalizeForSnapshot", () => {
  test.each([0, 0.1, 1.2])(
    "normalizes tool wall time of %s seconds",
    (seconds) => {
      expect(
        normalizeForSnapshot({
          output: {
            structuredContent: {
              exit_code: 0,
              output: "pi_tool_ok",
              truncated: false,
              wall_time_seconds: seconds,
            },
          },
        }),
      ).toEqual({
        output: {
          structuredContent: {
            exit_code: 0,
            output: "pi_tool_ok",
            truncated: false,
            wall_time_seconds: 0,
          },
        },
      });
    },
  );

  test("normalizes a foreign repository path ending at a workspace directory", () => {
    expect(
      normalizeForSnapshot(
        "find /another/checkout/braintrust-sdk-javascript/e2e -name AGENTS.md",
      ),
    ).toBe("find <repo>/e2e -name AGENTS.md");
  });
});
