import { defineConfig } from "vitest/config";
import {
  detectOtelVersion,
  logOtelVersions,
  createOtelAliases,
} from "../tests/utils";

const cwd = process.cwd();
const version = detectOtelVersion(cwd);

logOtelVersions(version);

export default defineConfig({
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
