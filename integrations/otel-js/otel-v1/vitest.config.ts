import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import {
  detectOtelVersion,
  logOtelVersions,
  createOtelAliases,
} from "../tests/utils";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const cwd = process.cwd();
const version = detectOtelVersion(cwd);

logOtelVersions(version);

export default defineConfig({
  define: {
    __BRAINTRUST_OTEL_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve:
    version !== "parent"
      ? {
          alias: createOtelAliases(cwd),
        }
      : {},
  test: {
    reporters: ["default"],
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
