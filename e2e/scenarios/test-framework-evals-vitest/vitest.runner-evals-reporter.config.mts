import { readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = process.env.BRAINTRUST_E2E_REPO_ROOT;
if (!repoRoot) {
  throw new Error("BRAINTRUST_E2E_REPO_ROOT is not set");
}

const testRunId = process.env.BRAINTRUST_E2E_RUN_ID;
if (!testRunId) {
  throw new Error("BRAINTRUST_E2E_RUN_ID is not set");
}

const { default: BraintrustVitestEvalsReporter } = await import(
  pathToFileURL(path.join(repoRoot, "js/dist/vitest-evals-reporter.mjs")).href
);
const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, "js/package.json"), "utf8"),
);

export default defineConfig({
  define: {
    __BRAINTRUST_SDK_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    hookTimeout: 30_000,
    include: ["runner.vitest-evals-reporter.case.ts"],
    reporters: [
      "vitest-evals/reporter",
      new BraintrustVitestEvalsReporter({
        displaySummary: false,
        experimentName: `vitest-evals-reporter-${testRunId}`,
        projectName:
          process.env.BRAINTRUST_E2E_PROJECT_NAME ||
          `e2e-vitest-evals-reporter-${testRunId}`,
      }),
    ],
    testTimeout: 20_000,
  },
});
