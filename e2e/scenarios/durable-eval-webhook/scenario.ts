import { BatchTask, DurableEval, type DurableEvalStore } from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

class MemoryStore implements DurableEvalStore {
  private readonly values = new Map<string, Uint8Array>();

  async read(key: string) {
    return this.values.get(key)?.slice();
  }

  async write(key: string, value: Uint8Array) {
    this.values.set(key, value.slice());
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
    Record<string, never>
  >({
    workflow(workflow) {
      const generated = workflow.batch("generate", {
        batchSize: 2,
        input: (item) => item.input,
        async submit(items) {
          const id = `generate-${jobs.size + 1}`;
          jobs.set(id, items);
          return { id };
        },
        completion: {
          mode: "webhook",
          externalId: (handle) => handle.id,
        },
        async collect(handle) {
          return (jobs.get(handle.id) ?? []).map((item) => ({
            id: item.id,
            output: item.input * 2,
          }));
        },
      });
      return workflow.batch("finalize", {
        needs: { generated },
        input: (_item, { generated }) => generated,
        batchSize: 2,
        async submit(items) {
          const id = `finalize-${jobs.size + 1}`;
          jobs.set(id, items);
          return { id };
        },
        completion: {
          mode: "webhook",
          externalId: (handle) => handle.id,
        },
        async collect(handle) {
          return (jobs.get(handle.id) ?? []).map((item) => ({
            id: item.id,
            output: item.input,
          }));
        },
      });
    },
  });
  const definition = DurableEval(
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
          return output === expected ? 1 : 0;
        },
      ],
    },
  );

  const waiting = await definition.start({
    runId: `durable-${testRunId}`,
  });
  if (waiting.status !== "waiting" || jobs.size !== 2) {
    throw new Error("Durable eval did not pause with two webhook batches");
  }

  let processed = waiting;
  const completedJobs = new Set<string>();
  while (completedJobs.size < jobs.size || processed.status !== "completed") {
    const externalId = [...jobs.keys()].find((id) => !completedJobs.has(id));
    if (!externalId) throw new Error("Durable eval stopped before completion");
    completedJobs.add(externalId);
    processed = await definition.processBatchResult({
      externalId,
    });
  }
}

runMain(main);
