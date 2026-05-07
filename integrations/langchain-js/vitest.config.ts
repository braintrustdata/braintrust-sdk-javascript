import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    setupFiles: ["./src/test/setup.ts"],
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
