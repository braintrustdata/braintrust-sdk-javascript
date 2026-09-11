import {
  WorkflowScorer,
  WorkflowTask,
  defineWorkflowEval,
  WorkflowEvalMemoryStore,
} from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const testRunId = getTestRunId();
  const scenario = "workflow-eval-webhook";
  const store = new WorkflowEvalMemoryStore();
  const jobs = new Map<
    string,
    { input: number; output?: number; expected: number }
  >();
  const webhookCompletion = {
    mode: "webhook" as const,
    getExternalId: (submissionData: { id: string }) => submissionData.id,
  };
  const task = new WorkflowTask<
    number,
    number,
    number,
    { testRunId: string; kind: string },
    Record<string, never>,
    { id: string }
  >({
    async submit(item) {
      const id = `task-${jobs.size + 1}`;
      jobs.set(id, item);
      return { id };
    },
    completion: webhookCompletion,
    async collect(submissionData) {
      return { output: jobs.get(submissionData.id)!.input * 2 };
    },
  });
  const scorer = new WorkflowScorer<
    number,
    number,
    number,
    { testRunId: string; kind: string },
    { id: string }
  >({
    name: "workflow_exact",
    async submit(item) {
      const id = `score-${jobs.size + 1}`;
      jobs.set(id, item);
      return { id };
    },
    completion: webhookCompletion,
    async collect(submissionData) {
      const item = jobs.get(submissionData.id)!;
      return {
        score: {
          score: item.output === item.expected ? 1 : 0,
          metadata: { method: "workflow-provider" },
        },
      };
    },
  });
  const definition = defineWorkflowEval(
    scopedName("e2e-workflow-eval-webhook-project", testRunId),
    {
      store,
      maxConcurrency: 2,
      experimentName: `${scenario}-${testRunId}`,
      data: [1, 2, 3].map((input) => ({
        id: `case-${input}`,
        input,
        expected: input * 2,
        metadata: { scenario, testRunId, kind: "webhook" },
      })),
      task,
      scores: [
        function exact({ output, expected }) {
          localScoreCount++;
          return {
            score: output === expected ? 1 : 0,
            metadata: { method: "shared-eval-runtime" },
          };
        },
        scorer,
      ],
      classifiers: [
        function quality({ output, expected }) {
          classifierCount++;
          return {
            name: "quality",
            id: output === expected ? "pass" : "fail",
            label: output === expected ? "Pass" : "Fail",
          };
        },
      ],
    },
  );

  let localScoreCount = 0;
  let classifierCount = 0;
  const waiting = await definition.start();
  if (waiting.status !== "waiting" || jobs.size !== 3) {
    throw new Error(
      "Workflow eval did not pause with three webhook submissions",
    );
  }

  // Finish the second case, including scoring, while the other tasks wait.
  const taskIds = [...jobs.keys()];
  const first = await definition.processSubmissionResult({
    runId: waiting.runId,
    externalId: taskIds[1],
  });
  if (
    first.status !== "waiting" ||
    first.pending.webhook !== 3 ||
    localScoreCount !== 1 ||
    classifierCount !== 1
  ) {
    throw new Error(
      "Completed case did not advance its scorers and classifier independently",
    );
  }
  const firstScoreId = [...jobs.keys()].find((id) => id.startsWith("score-"));
  if (!firstScoreId)
    throw new Error("Completed task did not submit its workflow scorer");
  const scored = await definition.processSubmissionResult({
    runId: waiting.runId,
    externalId: firstScoreId,
  });
  if (scored.status !== "waiting" || scored.pending.webhook !== 2) {
    throw new Error("Eval completed before the remaining tasks");
  }
  // A repeated delivery must not produce another scorer or log duplicate results.
  await definition.processSubmissionResult({
    runId: waiting.runId,
    externalId: taskIds[1],
  });
  const completedJobs = new Set([taskIds[1], firstScoreId]);
  for (const externalId of jobs.keys()) {
    if (completedJobs.has(externalId)) continue;
    await definition.processSubmissionResult({
      runId: waiting.runId,
      externalId,
    });
    completedJobs.add(externalId);
  }
  const completed = await definition.status({ runId: waiting.runId });
  if (
    completed.status !== "completed" ||
    [...jobs.keys()].filter((id) => id.startsWith("score-")).length !== 3
  ) {
    throw new Error(
      "Workflow eval did not complete three individual workflow scorers",
    );
  }
}

runMain(main);
