import { defineConfig } from "vitest/config";
import { E2E_TAGS } from "./helpers/tags";

export default defineConfig({
  test: {
    hookTimeout: 20_000,
    include: ["scenarios/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    tags: [
      {
        name: E2E_TAGS.hermetic,
        description:
          "Tests that run entirely against local mocks and fixtures.",
      },
    ],
    testTimeout: 20_000,
  },
});
