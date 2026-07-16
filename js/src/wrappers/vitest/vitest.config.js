import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  define: {
    __BRAINTRUST_SDK_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    hookTimeout: 60_000,
    reporters: ["default"],
  },
});
