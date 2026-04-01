import { defineConfig } from "vitest/config";
import { E2E_TAGS } from "./helpers/tags";

export default defineConfig({
  test: {
    hookTimeout: 20_000,
    include: ["scenarios/**/*.test.ts"],
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
    testTimeout: 20_000,
  },
});
