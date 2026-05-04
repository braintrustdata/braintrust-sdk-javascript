import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Add any specific test configuration if needed
  },
});
