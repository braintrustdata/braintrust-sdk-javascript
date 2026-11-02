import { defineConfig } from "vitest/config";

const testRunId = process.env.BRAINTRUST_E2E_RUN_ID;
if (!testRunId) {
  throw new Error("BRAINTRUST_E2E_RUN_ID is not set");
}

import BraintrustVitestEvalsReporter from "braintrust/vitest-evals-reporter";

export default defineConfig({
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
