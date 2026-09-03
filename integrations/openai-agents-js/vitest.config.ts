import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      braintrust: fileURLToPath(
        new URL("../../js/src/node/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    reporters: ["default"],
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Add any specific test configuration if needed
  },
});
