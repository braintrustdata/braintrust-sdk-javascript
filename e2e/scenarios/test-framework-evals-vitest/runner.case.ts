import * as path from "node:path";
import {
  afterAll as vitestAfterAll,
  beforeAll as vitestBeforeAll,
  describe as vitestDescribe,
  expect,
  test as vitestTest,
} from "vitest";
import { getTestRunId, scopedName } from "../../helpers/scenario-runtime";

const repoRoot = process.env.BRAINTRUST_E2E_REPO_ROOT;
if (!repoRoot) {
  throw new Error("BRAINTRUST_E2E_REPO_ROOT is not set");
}

const { login } = await import(path.join(repoRoot, "js/src/logger.ts"));
const { configureNode } = await import(
  path.join(repoRoot, "js/src/node/config.ts")
);
const { wrapVitest } = await import(
  path.join(repoRoot, "js/src/wrappers/vitest/index.ts")
);

configureNode();

const testRunId = getTestRunId();
const scenario = "test-framework-evals-vitest";
const projectName = scopedName("e2e-test-framework-evals-vitest", testRunId);

const bt = wrapVitest(
  {
    afterAll: vitestAfterAll,
    beforeAll: vitestBeforeAll,
    describe: vitestDescribe,
    expect,
    test: vitestTest,
  },
  {
    displaySummary: false,
    projectName,
  },
);

const { beforeAll, describe, logFeedback, logOutputs, test } = bt;

beforeAll(async () => {
  await login({
    apiKey: process.env.BRAINTRUST_API_KEY,
    appUrl: process.env.BRAINTRUST_APP_URL,
  });
});

describe("test-framework-evals-vitest", () => {
  test(
    "vitest simple pass",
    {
      metadata: {
        case: "simple-pass",
        scenario,
        testRunId,
      },
    },
    async () => {
      logOutputs({ phase: "simple-pass" });
      expect(2 + 2).toBe(4);
    },
  );

  test(
    "vitest configured span",
    {
      expected: 10,
      input: { value: 5 },
      metadata: {
        case: "configured-span",
        scenario,
        testRunId,
      },
      scorers: [
        ({ expected, output }) => {
          const result =
            typeof output === "object" &&
            output !== null &&
            "result" in output &&
            typeof output.result === "number"
              ? output.result
              : undefined;

          return {
            name: "correctness",
            score: result === expected ? 1 : 0,
          };
        },
      ],
      tags: ["math", "configured"],
    },
    async ({ input }) => {
      const result = (input as { value: number }).value * 2;
      logFeedback({ name: "quality", score: 0.9 });
      return {
        phase: "configured-span",
        result,
      };
    },
  );

  test.concurrent(
    "vitest concurrent alpha",
    {
      metadata: {
        case: "concurrent-alpha",
        scenario,
        testRunId,
      },
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      logOutputs({ phase: "concurrent-alpha" });
      expect(true).toBe(true);
    },
  );

  test.concurrent(
    "vitest concurrent beta",
    {
      metadata: {
        case: "concurrent-beta",
        scenario,
        testRunId,
      },
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      logOutputs({ phase: "concurrent-beta" });
      expect(true).toBe(true);
    },
  );

  test(
    "vitest expected failure",
    {
      fails: true,
      metadata: {
        case: "expected-failure",
        scenario,
        testRunId,
      },
    },
    async () => {
      logOutputs({ phase: "expected-failure" });
      expect("wrong").toBe("right");
    },
  );
});
