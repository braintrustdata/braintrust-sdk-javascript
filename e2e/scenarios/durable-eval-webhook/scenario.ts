import {
  BatchTask,
  DurableEval,
  MemoryDurableEvalStore,
  type DurableBatchTaskItem,
} from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const testRunId = getTestRunId();
  const store = new MemoryDurableEvalStore();
  const jobs = new Map<
    string,
    DurableBatchTaskItem<
      number,
      number,
      { testRunId: string; kind: string },
      Record<string, never>
    >[]
  >();
  const task = BatchTask<
    number,
    number,
    number,
    { testRunId: string; kind: string },
    Record<string, never>,
    { id: string }
  >({
    revision: "task-v1",
    batchSize: 2,
    maxConcurrentBatches: 2,
    async submit(items) {
      const id = `provider-${jobs.size + 1}`;
      jobs.set(id, items);
      return { id };
    },
    completion: {
      mode: "webhook",
      source: "e2e-provider",
      externalId: (handle) => handle.id,
    },
    async *collect(handle) {
      for (const item of jobs.get(handle.id) ?? []) {
        yield { id: item.id, output: item.input * 2 };
      }
    },
  });
  const definition = DurableEval(
    scopedName("e2e-durable-eval-webhook-project", testRunId),
    {
      revision: "eval-v1",
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
          return output === expected ? 1 : 0;
        },
      ],
    },
  );

  const waiting = await definition.run({
    runId: `durable-${testRunId}`,
    store,
  });
  if (
    waiting.status !== "paused" ||
    waiting.reason !== "waiting_for_webhook" ||
    jobs.size !== 2
  ) {
    throw new Error("Durable eval did not pause with two webhook batches");
  }

  for (let index = 1; index <= 2; index++) {
    const processed = await definition.processBatchResult(
      {
        eventId: `event-${index}`,
        source: "e2e-provider",
        externalId: `provider-${index}`,
        outcome: { status: "complete" },
      },
      { store },
    );
    if (processed.status !== "processed") {
      throw new Error(`Webhook ${index} was not processed`);
    }
    if (index === 2 && processed.run.status !== "completed") {
      throw new Error("Durable eval did not complete after the final webhook");
    }
  }

  const sharded = DurableEval(
    scopedName("e2e-durable-eval-sharded-project", testRunId),
    {
      revision: "eval-v1",
      data: [1, 2, 3, 4].map((input) => ({
        id: `shard-case-${input}`,
        input,
        metadata: { testRunId, kind: "sharded" },
      })),
      task: (input) => input * 10,
      scores: [],
    },
  );
  await Promise.all([
    sharded.run({
      runId: `sharded-${testRunId}`,
      shard: { index: 0, count: 2 },
      store,
    }),
    sharded.run({
      runId: `sharded-${testRunId}`,
      shard: { index: 1, count: 2 },
      store,
    }),
  ]);
}

runMain(main);
