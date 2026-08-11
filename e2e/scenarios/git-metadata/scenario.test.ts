import { expect, test } from "vitest";
import {
  prepareScenarioDir,
  resolveScenarioDir,
  withScenarioHarness,
} from "../../helpers/scenario-harness";

const scenarioDir = await prepareScenarioDir({
  scenarioDir: resolveScenarioDir(import.meta.url),
});

test("preserves git metadata on experiment spans", async () => {
  await withScenarioHarness(
    async ({ requestsAfter, runScenarioDir, testRunEvents }) => {
      const result = await runScenarioDir({ scenarioDir });
      const { baseCommit, featureCommit } = JSON.parse(result.stdout) as {
        baseCommit: string;
        featureCommit: string;
      };

      const registrationRequests = requestsAfter(
        0,
        (request) => request.path === "/api/experiment/register",
      );
      expect(registrationRequests).toHaveLength(2);

      expect(registrationRequests[0]?.jsonBody).toEqual(
        expect.objectContaining({
          ancestor_commits: [baseCommit],
          experiment_name: "git-metadata-base",
          repo_info: {
            author_email: "git-regression@braintrust.dev",
            author_name: "Braintrust Git Regression",
            branch: "main",
            commit: baseCommit,
            commit_message: "Deterministic base commit",
            commit_time: "2024-02-01T12:00:00Z",
            dirty: false,
            tag: "git-regression-base",
          },
        }),
      );

      expect(registrationRequests[1]?.jsonBody).toEqual(
        expect.objectContaining({
          ancestor_commits: [featureCommit],
          experiment_name: "git-metadata-feature",
          repo_info: {
            author_email: "git-regression@braintrust.dev",
            author_name: "Braintrust Git Regression",
            branch: "feature/git-metadata-regression",
            commit: featureCommit,
            commit_message: "Deterministic feature commit",
            commit_time: "2024-02-02T12:00:00Z",
            dirty: true,
            tag: "git-regression-feature",
          },
        }),
      );

      const spans = testRunEvents(
        (event) =>
          event.span.name === "git-metadata-regression" &&
          event.output !== undefined,
      );
      expect(spans).toHaveLength(2);
      expect(
        spans.map((event) => ({
          input: event.input,
          metadata: event.metadata,
          output: event.output,
        })),
      ).toEqual([
        {
          input: { case: "base" },
          metadata: expect.objectContaining({ gitRegressionCase: "base" }),
          output: { status: "recorded" },
        },
        {
          input: { case: "feature-dirty" },
          metadata: expect.objectContaining({
            gitRegressionCase: "feature-dirty",
          }),
          output: { status: "recorded" },
        },
      ]);
    },
  );
});
