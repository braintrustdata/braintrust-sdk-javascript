import { after, describe, test } from "node:test";
import { currentSpan, initNodeTestSuite, login } from "braintrust/node";

const testRunId = process.env.BRAINTRUST_E2E_RUN_ID;
const scenario = "test-framework-evals-node";
const scopedName = (base) =>
  `${base}-${testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

await login({
  apiKey: process.env.BRAINTRUST_API_KEY,
  appUrl: process.env.BRAINTRUST_APP_URL,
});

describe("test-framework-evals-node", () => {
  const suite = initNodeTestSuite({
    after,
    displaySummary: false,
    projectName: scopedName("e2e-test-framework-evals-node"),
  });

  test(
    "node-test basic eval",
    suite.eval(
      {
        input: "hello",
        metadata: {
          case: "basic-eval",
          scenario,
          testRunId,
        },
      },
      async ({ input }) => `echo:${input}`,
    ),
  );

  test(
    "node-test configured eval",
    suite.eval(
      {
        expected: 10,
        input: { value: 5 },
        metadata: {
          case: "configured-eval",
          scenario,
          testRunId,
        },
        scorers: [
          ({ expected, output }) => ({
            name: "correctness",
            score: output === expected ? 1 : 0,
          }),
        ],
        tags: ["math", "configured"],
      },
      async ({ input }) => input.value * 2,
    ),
  );

  test(
    "node-test extra output",
    suite.eval(
      {
        input: { mode: "extra" },
        metadata: {
          case: "extra-output",
          scenario,
          testRunId,
        },
      },
      async () => {
        currentSpan().log({
          output: {
            phase: "extra-output",
          },
          scores: {
            quality: 0.95,
          },
        });
        return { done: true };
      },
    ),
  );

  test(
    "node-test original name",
    suite.eval(
      {
        input: "override",
        metadata: {
          case: "name-override",
          scenario,
          testRunId,
        },
        name: "node-test overridden name",
      },
      async ({ input }) => input,
    ),
  );
});
