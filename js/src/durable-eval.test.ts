import { describe, expect, test, vi } from "vitest";
import { configureNode } from "./node/config";
import {
  BatchScorer,
  BatchTask,
  DurableEval,
  type DurableBatchScorerItem,
  type DurableBatchTaskItem,
  type DurableEvalStore,
} from "./durable-eval";

configureNode();

class MemoryStore implements DurableEvalStore {
  private readonly values = new Map<string, Uint8Array>();

  async read(key: string) {
    return this.values.get(key)?.slice();
  }

  async write(key: string, value: Uint8Array) {
    this.values.set(key, value.slice());
  }
}

describe("DurableEval", () => {
  test("runs ordinary tasks and scorers", async () => {
    const task = vi.fn((input: number) => input * 2);
    const result = await DurableEval("local", {
      store: new MemoryStore(),
      data: [
        { id: "one", input: 1, expected: 2 },
        { id: "two", input: 2, expected: 4 },
      ],
      task,
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
      ],
    }).start({ noSendLogs: true });

    expect(result).toMatchObject({
      status: "completed",
      summary: { scores: { exact: { score: 1 } } },
    });
    expect(task).toHaveBeenCalledTimes(2);
  });

  test("generates a new run id for every start", async () => {
    const durable = DurableEval("generated-runs", {
      store: new MemoryStore(),
      data: [{ input: 1 }],
      task: (input) => input,
      scores: [() => 1],
    });

    const first = await durable.start({ noSendLogs: true });
    const second = await durable.start({ noSendLogs: true });

    expect(first.runId).not.toBe(second.runId);
  });

  test("polls each existing task and scorer sub-batch once", async () => {
    const taskJobs = new Map<
      string,
      DurableBatchTaskItem<number, number, void, Record<string, never>>[]
    >();
    const scoreJobs = new Map<
      string,
      DurableBatchScorerItem<number, number, number, void>[]
    >();
    const taskPoll = vi.fn(async () => ({ status: "complete" as const }));
    const scorePoll = vi.fn(async () => ({ status: "complete" as const }));

    const task = BatchTask<
      number,
      number,
      number,
      void,
      Record<string, never>,
      { id: string }
    >({
      batchSize: 2,
      async submit(items) {
        const id = `task-${taskJobs.size + 1}`;
        taskJobs.set(id, items);
        return { id };
      },
      completion: {
        mode: "poll",
        poll: taskPoll,
      },
      async collect(handle) {
        return (taskJobs.get(handle.id) ?? []).map((item) => ({
          id: item.id,
          output: item.input * 2,
        }));
      },
    });
    const scorer = BatchScorer<number, number, number, void, { id: string }>({
      name: "exact",
      batchSize: 2,
      async submit(items) {
        const id = `score-${scoreJobs.size + 1}`;
        scoreJobs.set(id, items);
        return { id };
      },
      completion: {
        mode: "poll",
        poll: scorePoll,
      },
      async collect(handle) {
        return (scoreJobs.get(handle.id) ?? []).map((item) => ({
          id: item.id,
          score: item.output === item.expected ? 1 : 0,
        }));
      },
    });

    const store = new MemoryStore();
    const durable = DurableEval("polling-batches", {
      store,
      data: [1, 2, 3].map((input) => ({
        id: `case-${input}`,
        input,
        expected: input * 2,
      })),
      task,
      scores: [scorer],
    });
    const waiting = await durable.start({ noSendLogs: true });
    expect(waiting).toMatchObject({
      status: "waiting",
      runId: expect.any(String),
      pending: { poll: 2, webhook: 0 },
    });
    const options = { runId: waiting.runId };
    expect(taskJobs.size).toBe(2);
    expect(scoreJobs.size).toBe(0);
    await expect(durable.status(options)).resolves.toEqual({
      status: "waiting",
      runId: waiting.runId,
      pending: { poll: 2, webhook: 0 },
    });
    expect(taskJobs.size).toBe(2);
    expect(taskPoll).not.toHaveBeenCalled();

    await expect(durable.poll(options)).resolves.toEqual({
      status: "waiting",
      runId: waiting.runId,
      pending: { poll: 2, webhook: 0 },
    });
    expect(scoreJobs.size).toBe(2);
    expect(taskPoll).toHaveBeenCalledTimes(2);
    expect(scorePoll).not.toHaveBeenCalled();

    const result = await durable.poll(options);

    expect(result).toMatchObject({
      status: "completed",
      pending: { poll: 0, webhook: 0 },
      summary: { scores: { exact: { score: 1 } } },
    });
    await expect(durable.status(options)).resolves.toMatchObject({
      status: "completed",
      pending: { poll: 0, webhook: 0 },
      summary: { scores: { exact: { score: 1 } } },
    });
    expect(scorePoll).toHaveBeenCalledTimes(2);
    expect([...taskJobs.values()].map((items) => items.length)).toEqual([2, 1]);
    expect([...scoreJobs.values()].map((items) => items.length)).toEqual([
      2, 1,
    ]);
  });

  test("processes task and scorer webhook batches through one method", async () => {
    const store = new MemoryStore();
    const taskJobs = new Map<
      string,
      DurableBatchTaskItem<number, number, void, Record<string, never>>[]
    >();
    const scoreJobs = new Map<
      string,
      DurableBatchScorerItem<number, number, number, void>[]
    >();
    const task = BatchTask<
      number,
      number,
      number,
      void,
      Record<string, never>,
      { id: string }
    >({
      batchSize: 2,
      async submit(items) {
        const id = `task-provider-${taskJobs.size + 1}`;
        taskJobs.set(id, items);
        return { id };
      },
      completion: {
        mode: "webhook",
        externalId: (handle) => handle.id,
      },
      async collect(handle) {
        return (taskJobs.get(handle.id) ?? []).map((item) => ({
          id: item.id,
          output: item.input * 2,
        }));
      },
    });
    const scorer = BatchScorer<number, number, number, void, { id: string }>({
      name: "exact",
      batchSize: 2,
      async submit(items) {
        const id = `score-provider-${scoreJobs.size + 1}`;
        scoreJobs.set(id, items);
        return { id };
      },
      completion: {
        mode: "webhook",
        externalId: (handle) => handle.id,
      },
      async collect(handle) {
        return (scoreJobs.get(handle.id) ?? []).map((item) => ({
          id: item.id,
          score: item.output === item.expected ? 1 : 0,
        }));
      },
    });
    const durable = DurableEval("webhook-batches", {
      store,
      data: [1, 2, 3].map((input) => ({
        id: `case-${input}`,
        input,
        expected: input * 2,
      })),
      task,
      scores: [scorer],
    });

    const waiting = await durable.start({ noSendLogs: true });
    expect(waiting).toMatchObject({
      status: "waiting",
      runId: expect.any(String),
      pending: { poll: 0, webhook: 2 },
    });
    expect(taskJobs.size).toBe(2);
    const runId = waiting.runId;

    const taskIds = [...taskJobs.keys()];
    await expect(
      durable.processBatchResult({
        runId: "missing-run",
        externalId: taskIds[0],
      }),
    ).rejects.toThrow("DurableEval run missing-run is missing");
    for (const [index, externalId] of taskIds.entries()) {
      const result = await durable.processBatchResult({ runId, externalId });
      expect(result).toMatchObject({
        status: "waiting",
        pending: { poll: 0, webhook: index === 0 ? 1 : 2 },
      });
    }
    expect(scoreJobs.size).toBe(2);

    const scoreIds = [...scoreJobs.keys()];
    let result;
    for (const externalId of scoreIds) {
      result = await durable.processBatchResult({ runId, externalId });
    }
    expect(result).toMatchObject({
      status: "completed",
      pending: { poll: 0, webhook: 0 },
      summary: { scores: { exact: { score: 1 } } },
    });
  });

  test("runs multi-stage task and scorer workflows", async () => {
    const jobs = new Map<string, Array<{ id: string; input: unknown }>>();
    const submit = async (
      prefix: string,
      items: Array<{ id: string; input: unknown }>,
    ) => {
      const id = `${prefix}-${jobs.size + 1}`;
      jobs.set(id, items);
      return { id };
    };
    const completion = {
      mode: "poll" as const,
      async poll() {
        return { status: "complete" as const };
      },
    };

    const task = BatchTask<number, number, number, void, Record<string, never>>(
      {
        workflow(w) {
          const doubled = w.batch("double", {
            batchSize: 2,
            input: (item) => item.input,
            submit: (items) => submit("double", items),
            completion,
            async collect(handle) {
              return (jobs.get(handle.id) ?? []).map((item) => ({
                id: item.id,
                output: (item.input as number) * 2,
              }));
            },
          });
          const incremented = w.batch("increment", {
            needs: { doubled },
            input: (_item, outputs) => outputs.doubled,
            submit: (items) => submit("increment", items),
            completion,
            async collect(handle) {
              return (jobs.get(handle.id) ?? []).map((item) => ({
                id: item.id,
                output: (item.input as number) + 1,
              }));
            },
          });
          const decremented = w.batch("decrement", {
            needs: { doubled },
            input: (_item, outputs) => outputs.doubled,
            submit: (items) => submit("decrement", items),
            completion,
            async collect(handle) {
              return (jobs.get(handle.id) ?? []).map((item) => ({
                id: item.id,
                output: (item.input as number) - 1,
              }));
            },
          });
          return w.batch("combine", {
            needs: { incremented, decremented },
            input: (_item, outputs) => outputs,
            submit: (items) => submit("combine", items),
            completion,
            async collect(handle) {
              return (jobs.get(handle.id) ?? []).map((item) => {
                const value = item.input as {
                  incremented: number;
                  decremented: number;
                };
                return {
                  id: item.id,
                  output: (value.incremented + value.decremented) / 2,
                };
              });
            },
          });
        },
      },
    );
    const scorer = BatchScorer<number, number, number, void>({
      name: "exact",
      workflow(w) {
        const comparison = w.batch("compare", {
          input: (item) => ({
            output: item.output,
            expected: item.expected,
          }),
          submit: (items) => submit("compare", items),
          completion,
          async collect(handle) {
            return (jobs.get(handle.id) ?? []).map((item) => {
              const value = item.input as {
                output: number;
                expected: number;
              };
              return {
                id: item.id,
                output: value.output === value.expected,
              };
            });
          },
        });
        return w.batch("score", {
          needs: { comparison },
          input: (_item, outputs) => outputs.comparison,
          submit: (items) => submit("score", items),
          completion,
          async collect(handle) {
            return (jobs.get(handle.id) ?? []).map((item) => ({
              id: item.id,
              output: item.input ? 1 : 0,
            }));
          },
        });
      },
    });
    const store = new MemoryStore();
    const durable = DurableEval("workflow", {
      store,
      data: [1, 2, 3].map((input) => ({
        id: `case-${input}`,
        input,
        expected: input * 2,
      })),
      task,
      scores: [scorer],
    });
    const waiting = await durable.start({ noSendLogs: true });
    expect(waiting).toMatchObject({
      status: "waiting",
    });
    const options = { runId: waiting.runId };
    await expect(durable.poll(options)).resolves.toMatchObject({
      status: "waiting",
    });
    await expect(durable.poll(options)).resolves.toMatchObject({
      status: "waiting",
    });
    await expect(durable.poll(options)).resolves.toMatchObject({
      status: "waiting",
    });
    await expect(durable.poll(options)).resolves.toMatchObject({
      status: "waiting",
    });
    await expect(durable.poll(options)).resolves.toMatchObject({
      status: "completed",
      summary: { scores: { exact: { score: 1 } } },
    });
  });

  test("requires stable case ids", async () => {
    await expect(
      DurableEval("missing-ids", {
        store: new MemoryStore(),
        data: [{ input: "hello" }],
        task: BatchTask({
          async submit() {
            return { id: "unused" };
          },
          completion: {
            mode: "webhook",
            externalId: (handle) => handle.id,
          },
          async collect() {
            return [];
          },
        }),
        scores: [],
      }).start({ noSendLogs: true }),
    ).rejects.toThrow("requires id, upsert_id, or caseId");
  });
});
