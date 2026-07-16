import { readFileSync } from "node:fs";
import * as path from "node:path";

const vitestConfigPackageName =
  process.env.VITEST_CONFIG_PACKAGE_NAME ?? "vitest-v3-latest";
const { defineConfig } = await import(`${vitestConfigPackageName}/config`);

const repoRoot = process.env.BRAINTRUST_E2E_REPO_ROOT;
if (!repoRoot) {
  throw new Error("BRAINTRUST_E2E_REPO_ROOT is not set");
}

const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, "js/package.json"), "utf8"),
);

export default defineConfig({
  define: {
    __BRAINTRUST_SDK_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    hookTimeout: 30_000,
    include: ["runner.case.ts"],
    testTimeout: 20_000,
  },
});
