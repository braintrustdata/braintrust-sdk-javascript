import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    include: ["**/*.test.ts", "**/*.eval.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15000,
  },
});
