import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __BRAINTRUST_OTEL_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    reporters: ["default"],
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
