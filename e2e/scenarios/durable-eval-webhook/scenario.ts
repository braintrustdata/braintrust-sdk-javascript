import {
  BatchScorer,
  BatchTask,
  defineDurableEval,
  DurableEvalMemoryStore,
} from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const testRunId = getTestRunId();
  const store = new DurableEvalMemoryStore();
  const jobs = new Map<string, unknown[]>();
  const webhookCompletion = {
    mode: "webhook" as const,
    externalId: (handle: { id: string }) => handle.id,
  };
  const task = BatchTask<
    number,
    number,
    number,
    { testRunId: string; kind: string },
    Record<string, never>
  >({
    batchSize: 2,
    async submit(items) {
      const id = `task-${jobs.size + 1}`;
      jobs.set(id, items);
      return { id };
    },
    completion: webhookCompletion,
    async collect(handle) {
      const items = (jobs.get(handle.id) ?? []) as Array<{
        id: string;
        input: number;
      }>;
      return items.map((item) => ({
        id: item.id,
        output: item.input * 2,
      }));
    },
  });
  const scorer = BatchScorer<
    number,
    number,
    number,
    { testRunId: string; kind: string },
    { id: string }
  >({
    name: "batch_exact",
    batchSize: 2,
    async submit(items) {
      const id = `score-${jobs.size + 1}`;
      jobs.set(id, items);
      return { id };
    },
    completion: webhookCompletion,
    async collect(handle) {
      const items = (jobs.get(handle.id) ?? []) as Array<{
        id: string;
        output: number;
        expected: number;
      }>;
      return items.map((item) => ({
        id: item.id,
        score: {
          name: "batch_exact",
          score: item.output === item.expected ? 1 : 0,
          metadata: { method: "batch-provider" },
        },
      }));
    },
  });
  const definition = defineDurableEval(
    scopedName("e2e-durable-eval-webhook-project", testRunId),
    {
      store,
      experimentName: scopedName(
        "e2e-durable-eval-webhook-experiment",
        testRunId,
      ),
      data: [1, 2, 3].map((input) => ({
        id: `case-${input}`,
        input,
        expected: input * 2,
        metadata: { testRunId, kind: "webhook" },
      })),
      task,
      scores: [
        function exact({ output, expected }) {
          return {
            name: "exact",
            score: output === expected ? 1 : 0,
            metadata: { method: "shared-eval-runtime" },
          };
        },
        scorer,
      ],
      classifiers: [
        function quality({ output, expected }) {
          return {
            name: "quality",
            id: output === expected ? "pass" : "fail",
            label: output === expected ? "Pass" : "Fail",
          };
        },
      ],
    },
  );

  const waiting = await definition.start();
  if (waiting.status !== "waiting" || jobs.size !== 2) {
    throw new Error("Durable eval did not pause with two webhook batches");
  }

  let completed = false;
  const completedJobs = new Set<string>();
  while (completedJobs.size < jobs.size || !completed) {
    const externalId = [...jobs.keys()].find((id) => !completedJobs.has(id));
    if (!externalId) throw new Error("Durable eval stopped before completion");
    completedJobs.add(externalId);
    const processed = await definition.processBatchResult({
      runId: waiting.runId,
      externalId,
    });
    completed = processed.status === "completed";
  }
  if ([...jobs.keys()].filter((id) => id.startsWith("score-")).length !== 2) {
    throw new Error("Batch scorer did not split three cases into two batches");
  }
}

runMain(main);
