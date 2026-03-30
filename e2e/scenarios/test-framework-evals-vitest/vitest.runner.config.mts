import { defineConfig } from "vitest-v2/config";

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    include: ["runner.case.ts"],
    testTimeout: 20_000,
  },
});
