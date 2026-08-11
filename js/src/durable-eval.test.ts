import { describe, expect, test, vi } from "vitest";
import { configureNode } from "./node/config";
import {
  BatchScorer,
  BatchTask,
  defineDurableEval,
  DurableEvalMemoryStore,
  DurableEvalRedisStore,
  type DurableBatchScorerItem,
  type DurableBatchTaskItem,
  type DurableEvalStore,
} from "./durable-eval";

configureNode();

describe("durable eval stores", () => {
  test("memory store copies values on read and write", async () => {
    const store = new DurableEvalMemoryStore();
    const value = new Uint8Array([1, 2, 3]);

    await store.write("run", value);
    value[0] = 9;

    const firstRead = await store.read("run");
    expect(firstRead).toEqual(new Uint8Array([1, 2, 3]));
    firstRead![1] = 9;
    expect(await store.read("run")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.read("missing")).toBeUndefined();

    const [first, second] = await Promise.all([
      store.getOrSet("claim", new Uint8Array([1])),
      store.getOrSet("claim", new Uint8Array([2])),
    ]);
    expect([first.created, second.created]).toEqual([true, false]);
    expect(first.value).toEqual(new Uint8Array([1]));
    expect(second.value).toEqual(new Uint8Array([1]));
  });

  test("redis store uses prefixed string operations", async () => {
    const values = new Map<string, string>();
    const client = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, _options?: unknown) => {
        values.set(key, value);
        return "OK";
      }),
      sendCommand: vi.fn(),
    };
    const store = new DurableEvalRedisStore({
      client,
      keyPrefix: "evals:",
      ttlMs: 1_234,
    });

    await store.write("run", new Uint8Array([0, 255, 1]));

    expect(client.set).toHaveBeenCalledWith("evals:run", "AP8B", {
      PX: 1_234,
    });
    expect(await store.read("run")).toEqual(new Uint8Array([0, 255, 1]));
    expect(client.get).toHaveBeenCalledWith("evals:run");
    expect(await store.read("missing")).toBeUndefined();

    await expect(
      new DurableEvalRedisStore({
        client: {
          get: async () => 42,
          set: async () => "OK",
        },
      }).read("invalid"),
    ).rejects.toThrow("expected GET to return a string");
    expect(() => new DurableEvalRedisStore({ client, ttlMs: 0 })).toThrow(
      "ttlMs must be a positive integer",
    );
  });

  test("redis store uses node-redis atomic SET options", async () => {
    const values = new Map<string, string>();
    const client = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(
        async (
          key: string,
          value: string,
          options?: { PX?: number; NX?: boolean; GET?: boolean },
        ) => {
          expect(options).toEqual({ PX: 1_234, NX: true, GET: true });
          const existing = values.get(key) ?? null;
          if (existing === null) values.set(key, value);
          return existing;
        },
      ),
      sendCommand: vi.fn(),
    };
    const store = new DurableEvalRedisStore({ client, ttlMs: 1_234 });

    await expect(store.getOrSet("claim", new Uint8Array([1]))).resolves.toEqual(
      { value: new Uint8Array([1]), created: true },
    );
    await expect(store.getOrSet("claim", new Uint8Array([2]))).resolves.toEqual(
      { value: new Uint8Array([1]), created: false },
    );
  });

  test("redis store uses ioredis atomic SET arguments", async () => {
    const values = new Map<string, string>();
    const client = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, ...options: unknown[]) => {
        expect(options).toEqual(["PX", 1_234, "NX", "GET"]);
        const existing = values.get(key) ?? null;
        if (existing === null) values.set(key, value);
        return existing;
      }),
      defineCommand: vi.fn(),
    };
    const store = new DurableEvalRedisStore({ client, ttlMs: 1_234 });

    await expect(store.getOrSet("claim", new Uint8Array([1]))).resolves.toEqual(
      { value: new Uint8Array([1]), created: true },
    );
    await expect(store.getOrSet("claim", new Uint8Array([2]))).resolves.toEqual(
      { value: new Uint8Array([1]), created: false },
    );
  });

  test("redis store uses Upstash atomic SET options", async () => {
    const values = new Map<string, string>();
    const client = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(
        async (
          key: string,
          value: string,
          options?: { px?: number; nx?: boolean; get?: boolean },
        ) => {
          expect(options).toEqual({ px: 1_234, nx: true, get: true });
          const existing = values.get(key) ?? null;
          if (existing === null) values.set(key, value);
          return existing;
        },
      ),
      createScript: vi.fn(),
    };
    const store = new DurableEvalRedisStore({ client, ttlMs: 1_234 });

    await expect(store.getOrSet("claim", new Uint8Array([1]))).resolves.toEqual(
      { value: new Uint8Array([1]), created: true },
    );
    await expect(store.getOrSet("claim", new Uint8Array([2]))).resolves.toEqual(
      { value: new Uint8Array([1]), created: false },
    );
  });
});

describe("defineDurableEval", () => {
  test("runs ordinary tasks and scorers", async () => {
    const task = vi.fn((input: number) => input * 2);
    const result = await defineDurableEval("local", {
      store: new DurableEvalMemoryStore(),
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
    const durable = defineDurableEval("generated-runs", {
      store: new DurableEvalMemoryStore(),
      data: [{ input: 1 }],
      task: (input) => input,
      scores: [() => 1],
    });

    const first = await durable.start({ noSendLogs: true });
    const second = await durable.start({ noSendLogs: true });

    expect(first.runId).not.toBe(second.runId);
  });

  test("merges batch task metadata with case metadata", async () => {
    type Metadata = { fromCase?: boolean; fromTask?: boolean };
    let taskItems: DurableBatchTaskItem<
      number,
      void,
      Metadata,
      Record<string, never>
    >[] = [];
    let scorerMetadata: Metadata | undefined;
    const task = new BatchTask<
      number,
      number,
      void,
      Metadata,
      Record<string, never>
    >({
      async submit(items) {
        taskItems = items;
        return null;
      },
      completion: {
        mode: "poll",
        async poll() {
          return { status: "complete" };
        },
      },
      async collect() {
        return taskItems.map((item) => ({
          id: item.id,
          output: item.input,
          metadata: { fromTask: true },
        }));
      },
    });
    const durable = defineDurableEval("merged-batch-metadata", {
      store: new DurableEvalMemoryStore(),
      data: [{ id: "one", input: 1, metadata: { fromCase: true } }],
      task,
      scores: [
        ({ metadata }) => {
          scorerMetadata = metadata;
          return 1;
        },
      ],
    });

    const waiting = await durable.start({ noSendLogs: true });
    await durable.poll({ runId: waiting.runId });

    expect(scorerMetadata).toEqual({ fromCase: true, fromTask: true });
  });

  test("stores run, case, and batch records separately", async () => {
    const values = new Map<string, Uint8Array>();
    const store: DurableEvalStore = {
      async read(key) {
        return values.get(key);
      },
      async write(key, value) {
        values.set(key, value);
      },
      async getOrSet(key, value) {
        const existing = values.get(key);
        if (existing) return { value: existing, created: false };
        values.set(key, value);
        return { value, created: true };
      },
    };
    const task = new BatchTask<
      number,
      number,
      void,
      void,
      Record<string, never>,
      { id: string }
    >({
      async submit() {
        return { id: "provider-job" };
      },
      completion: {
        mode: "poll",
        async poll() {
          return { status: "pending" };
        },
      },
      async collect() {
        return [];
      },
    });

    await defineDurableEval("normalized-store", {
      store,
      data: [
        { id: "one", input: 1 },
        { id: "two", input: 2 },
      ],
      task,
    }).start({ noSendLogs: true });

    const decoder = new TextDecoder();
    const records = [...values]
      .filter(([key]) => !key.includes("/claims/"))
      .map(
        ([key, value]) =>
          [
            key,
            JSON.parse(decoder.decode(value)) as Record<string, unknown>,
          ] as const,
      );
    const run = records.find(
      ([key]) => !key.includes("/cases/") && !key.includes("/batches/"),
    )?.[1];
    expect(run).toMatchObject({
      status: "running",
      caseIds: ["one:trial:0", "two:trial:0"],
    });
    expect(run).not.toHaveProperty("schemaVersion");
    expect(run).not.toHaveProperty("projectName");
    expect(run).not.toHaveProperty("evalName");
    expect(run).not.toHaveProperty("cases");
    expect(run).not.toHaveProperty("batches");
    expect(run).not.toHaveProperty("batchIds");
    expect(records.filter(([key]) => key.includes("/cases/"))).toHaveLength(2);
    expect(records.filter(([key]) => key.includes("/batches/"))).toHaveLength(
      1,
    );
    expect(
      [...values.keys()].filter((key) => key.includes("/claims/")),
    ).toHaveLength(1);
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

    const task = new BatchTask<
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
      async collect(submission) {
        return (taskJobs.get(submission.id) ?? []).map((item) => ({
          id: item.id,
          output: item.input * 2,
        }));
      },
    });
    const scorer = new BatchScorer<
      number,
      number,
      number,
      void,
      { id: string }
    >({
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
      async collect(submission) {
        return (scoreJobs.get(submission.id) ?? []).map((item) => ({
          id: item.id,
          score: item.output === item.expected ? 1 : 0,
        }));
      },
    });

    const store = new DurableEvalMemoryStore();
    const durable = defineDurableEval("polling-batches", {
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
    const store = new DurableEvalMemoryStore();
    const taskJobs = new Map<
      string,
      DurableBatchTaskItem<number, number, void, Record<string, never>>[]
    >();
    const scoreJobs = new Map<
      string,
      DurableBatchScorerItem<number, number, number, void>[]
    >();
    let taskCollectCount = 0;
    let releaseTaskCollect!: () => void;
    const taskBatchesCollecting = new Promise<void>((resolve) => {
      releaseTaskCollect = resolve;
    });
    const task = new BatchTask<
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
        externalId: (submission) => submission.id,
      },
      async collect(submission) {
        taskCollectCount++;
        if (taskCollectCount === 2) releaseTaskCollect();
        await taskBatchesCollecting;
        return (taskJobs.get(submission.id) ?? []).map((item) => ({
          id: item.id,
          output: item.input * 2,
        }));
      },
    });
    const scorer = new BatchScorer<
      number,
      number,
      number,
      void,
      { id: string }
    >({
      name: "exact",
      batchSize: 2,
      async submit(items) {
        const id = `score-provider-${scoreJobs.size + 1}`;
        scoreJobs.set(id, items);
        return { id };
      },
      completion: {
        mode: "webhook",
        externalId: (submission) => submission.id,
      },
      async collect(submission) {
        return (scoreJobs.get(submission.id) ?? []).map((item) => ({
          id: item.id,
          score: item.output === item.expected ? 1 : 0,
        }));
      },
    });
    const durable = defineDurableEval("webhook-batches", {
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
    ).rejects.toThrow("Durable eval run missing-run is missing");
    await Promise.all(
      taskIds.map((externalId) =>
        durable.processBatchResult({ runId, externalId }),
      ),
    );
    expect(scoreJobs.size).toBe(2);
    await expect(durable.status({ runId })).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 0, webhook: 2 },
    });

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

  test("claims downstream work once across concurrent webhook deliveries", async () => {
    let taskItems: DurableBatchTaskItem<
      number,
      number,
      void,
      Record<string, never>
    >[] = [];
    let collectCount = 0;
    let releaseCollect!: () => void;
    const bothCollecting = new Promise<void>((resolve) => {
      releaseCollect = resolve;
    });
    const task = new BatchTask<
      number,
      number,
      number,
      void,
      Record<string, never>,
      { id: string }
    >({
      async submit(items) {
        taskItems = items;
        return { id: "task-provider" };
      },
      completion: {
        mode: "webhook",
        externalId: (submission) => submission.id,
      },
      async collect() {
        collectCount++;
        if (collectCount === 2) releaseCollect();
        await bothCollecting;
        return taskItems.map((item) => ({
          id: item.id,
          output: item.input * 2,
        }));
      },
    });
    const scoreSubmit = vi.fn(async () => ({ id: "score-provider" }));
    const scorer = new BatchScorer<
      number,
      number,
      number,
      void,
      { id: string }
    >({
      name: "exact",
      submit: scoreSubmit,
      completion: {
        mode: "webhook",
        externalId: (submission) => submission.id,
      },
      async collect() {
        return [];
      },
    });
    const durable = defineDurableEval("concurrent-webhooks", {
      store: new DurableEvalMemoryStore(),
      data: [{ id: "one", input: 2, expected: 4 }],
      task,
      scores: [scorer],
    });
    const waiting = await durable.start({ noSendLogs: true });

    await Promise.all([
      durable.processBatchResult({
        runId: waiting.runId,
        externalId: "task-provider",
      }),
      durable.processBatchResult({
        runId: waiting.runId,
        externalId: "task-provider",
      }),
    ]);

    expect(scoreSubmit).toHaveBeenCalledTimes(1);
    await expect(
      durable.status({ runId: waiting.runId }),
    ).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 0, webhook: 1 },
    });
  });

  test("supports scorer names inherited from Object.prototype", async () => {
    const jobs = new Map<
      string,
      Array<{ id: string; input: number; expected?: number; output?: number }>
    >();
    const completion = {
      mode: "poll" as const,
      async poll() {
        return { status: "complete" as const };
      },
    };
    const task = new BatchTask<
      number,
      number,
      number,
      void,
      Record<string, never>
    >({
      async submit(items) {
        jobs.set("task", items);
        return { id: "task" };
      },
      completion,
      async collect() {
        return (jobs.get("task") ?? []).map((item) => ({
          id: item.id,
          output: item.input * 2,
        }));
      },
    });
    const scorer = new BatchScorer<
      number,
      number,
      number,
      void,
      { id: string }
    >({
      name: "__proto__",
      async submit(items) {
        jobs.set("score", items);
        return { id: "score" };
      },
      completion,
      async collect() {
        return (jobs.get("score") ?? []).map((item) => ({
          id: item.id,
          score: item.output === item.expected ? 1 : 0,
        }));
      },
    });
    const durable = defineDurableEval("prototype-names", {
      store: new DurableEvalMemoryStore(),
      data: [{ id: "one", input: 2, expected: 4 }],
      task,
      scores: [scorer],
    });

    const waiting = await durable.start({ noSendLogs: true });
    await expect(durable.poll({ runId: waiting.runId })).resolves.toMatchObject(
      {
        status: "waiting",
      },
    );
    const result = await durable.poll({ runId: waiting.runId });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Eval did not complete");
    expect(Object.hasOwn(result.summary.scores, "__proto__")).toBe(true);
    expect(result.summary.scores.__proto__?.score).toBe(1);
  });

  test("requires stable case ids", async () => {
    await expect(
      defineDurableEval("missing-ids", {
        store: new DurableEvalMemoryStore(),
        data: [{ input: "hello" }],
        task: new BatchTask({
          async submit() {
            return { id: "unused" };
          },
          completion: {
            mode: "webhook",
            externalId: (submission) => submission.id,
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
