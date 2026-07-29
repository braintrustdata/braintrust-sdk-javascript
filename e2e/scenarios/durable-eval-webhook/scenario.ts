import { BatchTask, DurableEval, type DurableEvalStore } from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

class MemoryStore implements DurableEvalStore {
  private readonly values = new Map<
    string,
    { value: Uint8Array; version: number }
  >();

  async read(key: string) {
    const record = this.values.get(key);
    return record
      ? { value: record.value.slice(), version: String(record.version) }
      : undefined;
  }

  async write(
    key: string,
    value: Uint8Array,
    condition: Parameters<DurableEvalStore["write"]>[2],
  ) {
    const current = this.values.get(key);
    if (
      ("ifAbsent" in condition && current) ||
      ("ifVersion" in condition &&
        (!current || String(current.version) !== condition.ifVersion))
    ) {
      return {
        written: false as const,
        currentVersion: current ? String(current.version) : undefined,
      };
    }
    const version = (current?.version ?? 0) + 1;
    this.values.set(key, { value: value.slice(), version });
    return { written: true as const, version: String(version) };
  }

  async *list(prefix: string) {
    for (const key of [...this.values.keys()].sort()) {
      if (key.startsWith(prefix)) yield key;
    }
  }
}

async function main() {
  const testRunId = getTestRunId();
  const store = new MemoryStore();
  const jobs = new Map<string, Array<{ id: string; input: number }>>();
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
