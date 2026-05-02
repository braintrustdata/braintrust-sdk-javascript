import { defineConfig } from "vitest/config";
import { E2E_TAGS } from "./helpers/tags";

export default defineConfig({
  test: {
    include: ["scenarios/**/*.test.ts", "helpers/**/*.test.ts"],
    // We run the scenarios in the hooks.
    hookTimeout: 120_000,
    testTimeout: 20_000,
    // 120 seconds - our testsuite is inherently slow because of LLMs and if a
    // test is slower than the threshold (default 300ms) it will not show up in
    // the reporter output.
    slowTestThreshold: 120_000,
    // Default to one retry for provider/network flake in non-hermetic scenarios.
    retry: 1,
    setupFiles: ["./vitest.setup.ts"],
    tags: [
      {
        name: E2E_TAGS.hermetic,
        description:
          "Tests that run entirely against local mocks and fixtures.",
        // Hermetic tests should be deterministic and fail immediately.
        retry: 0,
      },
    ],
  },
});
