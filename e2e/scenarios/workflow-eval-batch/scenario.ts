import {
  WorkflowBatchScorer,
  WorkflowBatchTask,
  defineWorkflowEval,
  WorkflowEvalMemoryStore,
} from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

type Metadata = { scenario: string; testRunId: string; kind: string };

async function main() {
  const testRunId = getTestRunId();
  const scenario = "workflow-eval-batch";
  const store = new WorkflowEvalMemoryStore();
  // Stands in for a provider batch API, keyed by provider batch ID.
  const batches = new Map<
    string,
    Array<{ customId: string; input: number; output?: number }>
  >();
  const task = new WorkflowBatchTask<
    number,
    number,
    number,
    Metadata,
    Record<string, never>,
    { batchId: string }
  >({
    batching: { maxSize: 3 },
    async submit(items) {
      const batchId = `task-batch-${batches.size + 1}`;
      batches.set(batchId, items);
      return { batchId };
    },
    completion: {
      mode: "webhook",
      getExternalId: ({ batchId }) => batchId,
    },
    async *collect({ batchId }) {
      for (const { customId, input } of batches.get(batchId)!) {
        yield input === 4
          ? { customId, error: "provider rejected request" }
          : { customId, result: { output: input * 2 } };
      }
    },
  });
  const scorer = new WorkflowBatchScorer<
    number,
    number,
    number,
    Metadata,
    { batchId: string }
  >({
    name: "batch_exact",
    batching: { maxSize: 10 },
    async submit(items) {
      const batchId = `score-batch-${batches.size + 1}`;
      batches.set(batchId, items);
      return { batchId };
    },
    completion: {
      mode: "poll",
      async poll() {
        return { status: "complete" };
      },
    },
    async collect({ batchId }) {
      return batches.get(batchId)!.map(({ customId, input, output }) =>
        input === 3
          ? { customId, error: "judge unavailable" }
          : {
              customId,
              result: {
                score: {
                  score: output === input * 2 ? 1 : 0,
                  metadata: { method: "batch-provider" },
                },
              },
            },
      );
    },
  });
  const definition = defineWorkflowEval(
    scopedName("e2e-workflow-eval-batch-project", testRunId),
    {
      store,
      experimentName: `${scenario}-${testRunId}`,
      data: [1, 2, 3, 4].map((input) => ({
        id: `case-${input}`,
        input,
        expected: input * 2,
        metadata: { scenario, testRunId, kind: "batch" },
      })),
      task,
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
        scorer,
      ],
    },
  );

  const waiting = await definition.start();
  if (waiting.status !== "waiting" || batches.size !== 2) {
    throw new Error("Workflow eval did not submit two task batches");
  }
  // Provider webhooks only carry the batch ID, so omit runId.
  const first = await definition.processSubmissionResult({
    externalId: "task-batch-1",
  });
  if (first.status !== "waiting" || batches.size !== 2) {
    throw new Error("Scorer submitted before the task stage finished");
  }
  await definition.processSubmissionResult({ externalId: "task-batch-2" });
  const scoreBatch = batches.get("score-batch-3");
  if (scoreBatch?.length !== 3) {
    throw new Error("Scorer did not batch the three successful tasks");
  }
  const completed = await definition.poll({ runId: waiting.runId });
  if (completed.status !== "completed") {
    throw new Error("Workflow eval did not complete after the scorer batch");
  }
}

runMain(main);
