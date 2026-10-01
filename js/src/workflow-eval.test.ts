import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { configureNode } from "./node/config";
import {
  WorkflowBatchScorer,
  WorkflowBatchTask,
  WorkflowScorer,
  WorkflowTask,
  defineWorkflowEval,
  WorkflowEvalMemoryStore,
  WorkflowEvalRedisStore,
  type WorkflowBatchItem,
  type WorkflowBatchItemResult,
  type WorkflowScorerItem,
  type WorkflowTaskItem,
  type WorkflowEvalStore,
} from "./workflow-eval";

configureNode();

describe("workflow eval stores", () => {
  test("progress sets deduplicate concurrent additions", async () => {
    const store = new WorkflowEvalMemoryStore();
    expect(await store.getSetSize("progress")).toBe(0);
    await Promise.all(
      ["one", "two", "one"].map((id) => store.addToSet("progress", id)),
    );
    expect(await store.getSetSize("progress")).toBe(2);
  });

  test.each(["node-redis", "ioredis", "upstash"])(
    "%s progress sets use atomic Redis scripts",
    async (variant) => {
      const evalCommand = vi.fn(async () => 2);
      const client = {
        get: async () => null,
        set: async () => "OK",
        eval: evalCommand,
        ...(variant === "node-redis"
          ? { sendCommand() {} }
          : variant === "ioredis"
            ? { defineCommand() {} }
            : { createScript() {} }),
      };
      const store = new WorkflowEvalRedisStore({
        client,
        keyPrefix: "test:",
        ttlMs: 1234,
      });
      await store.addToSet("progress", "case-one");
      expect(await store.getSetSize("progress")).toBe(2);
      const script =
        "redis.call('SADD', KEYS[1], ARGV[1]); redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1";
      expect(evalCommand.mock.calls[0]).toEqual(
        variant === "node-redis"
          ? [
              script,
              { keys: ["test:progress"], arguments: ["case-one", "1234"] },
            ]
          : variant === "ioredis"
            ? [script, 1, "test:progress", "case-one", "1234"]
            : [script, ["test:progress"], ["case-one", "1234"]],
      );
      expect(evalCommand.mock.calls[1]).toEqual(
        variant === "node-redis"
          ? [
              "return redis.call('SCARD', KEYS[1])",
              { keys: ["test:progress"], arguments: [] },
            ]
          : variant === "ioredis"
            ? ["return redis.call('SCARD', KEYS[1])", 1, "test:progress"]
            : ["return redis.call('SCARD', KEYS[1])", ["test:progress"], []],
      );
    },
  );

  test("memory store copies values on read and write", async () => {
    const store = new WorkflowEvalMemoryStore();
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
    const store = new WorkflowEvalRedisStore({
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
      new WorkflowEvalRedisStore({
        client: {
          get: async () => 42,
          set: async () => "OK",
        },
      }).read("invalid"),
    ).rejects.toThrow("expected GET to return a string");
    expect(() => new WorkflowEvalRedisStore({ client, ttlMs: 0 })).toThrow(
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
    const store = new WorkflowEvalRedisStore({ client, ttlMs: 1_234 });

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
    const store = new WorkflowEvalRedisStore({ client, ttlMs: 1_234 });

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
    const store = new WorkflowEvalRedisStore({ client, ttlMs: 1_234 });

    await expect(store.getOrSet("claim", new Uint8Array([1]))).resolves.toEqual(
      { value: new Uint8Array([1]), created: true },
    );
    await expect(store.getOrSet("claim", new Uint8Array([2]))).resolves.toEqual(
      { value: new Uint8Array([1]), created: false },
    );
  });
});

describe("defineWorkflowEval", () => {
  test.each(["poll", "rejected poll", "collect"])(
    "a scorer %s failure does not block other cases",
    async (failure) => {
      const f = workflowEval("poll");
      const { runId } = await f.definition.start({ noSendLogs: true });
      f.ready.add("task-one:trial:0");
      await f.definition.poll({ runId });
      f.ready.add("task-two:trial:0");
      f.ready.add("task-three:trial:0");
      f.ready.add("score-one:trial:0");
      if (failure !== "collect") {
        f.poll.mockImplementation(async ({ id }) => {
          if (id === "score-one:trial:0") {
            if (failure === "rejected poll") throw new Error("scorer failed");
            return { status: "failed", error: "scorer failed" };
          }
          return { status: f.ready.has(id) ? "complete" : "pending" };
        });
      } else {
        f.scoreCollect.mockRejectedValueOnce(new Error("scorer failed"));
      }
      await expect(f.definition.poll({ runId })).rejects.toThrow(
        "scorer failed",
      );
      expect(f.taskCollect).toHaveBeenCalledTimes(3);
      expect(f.scoreSubmit).toHaveBeenCalledTimes(3);
      expect(f.localScore).toHaveBeenCalledTimes(3);
      expect(f.classifier).toHaveBeenCalledTimes(3);
      await expect(f.definition.status({ runId })).resolves.toMatchObject({
        pending: { poll: 3, webhook: 0 },
      });
      f.poll.mockImplementation(async () => ({ status: "complete" }));
      await expect(f.definition.poll({ runId })).resolves.toMatchObject({
        status: "completed",
      });
    },
  );

  test("polling retries an interrupted progress update", async () => {
    const store = new WorkflowEvalMemoryStore();
    const f = workflowEval("poll", store);
    const { runId } = await f.definition.start({ noSendLogs: true });
    const addToSet = store.addToSet.bind(store);
    let interrupted = false;
    vi.spyOn(store, "addToSet").mockImplementation(async (key, member) => {
      if (!interrupted && key.endsWith("/poll/complete")) {
        interrupted = true;
        throw new Error("store unavailable");
      }
      return addToSet(key, member);
    });
    f.ready.add("task-one:trial:0");
    await expect(f.definition.poll({ runId })).rejects.toThrow(
      "store unavailable",
    );
    expect(f.taskCollect).toHaveBeenCalledTimes(1);
    await f.definition.poll({ runId });
    expect(f.taskCollect).toHaveBeenCalledTimes(2);
    expect(f.scoreSubmit).toHaveBeenCalledTimes(1);
    await expect(f.definition.status({ runId })).resolves.toMatchObject({
      pending: { poll: 3, webhook: 0 },
    });
    f.poll.mockImplementation(async () => ({ status: "complete" }));
    await f.definition.poll({ runId });
    await expect(f.definition.poll({ runId })).resolves.toMatchObject({
      status: "completed",
    });
  });

  test.each([undefined, 1, 3])(
    "bounds submission and polling concurrency at %s",
    async (maxConcurrency) => {
      const active = { submit: 0, poll: 0, collect: 0 };
      const peaks = { ...active };
      const task = new WorkflowTask({
        async submit() {
          peaks.submit = Math.max(peaks.submit, ++active.submit);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active.submit--;
          return null;
        },
        completion: {
          mode: "poll",
          async poll() {
            peaks.poll = Math.max(peaks.poll, ++active.poll);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active.poll--;
            return { status: "complete" };
          },
        },
        async collect() {
          peaks.collect = Math.max(peaks.collect, ++active.collect);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active.collect--;
          return { output: 1 };
        },
      });
      const definition = defineWorkflowEval("concurrency", {
        store: new WorkflowEvalMemoryStore(),
        maxConcurrency,
        data: Array.from({ length: 12 }, (_, input) => ({
          id: String(input),
          input,
        })),
        task,
      });
      const { runId } = await definition.start({ noSendLogs: true });
      await expect(definition.poll({ runId })).resolves.toMatchObject({
        status: "completed",
      });
      expect(peaks.submit).toBe(maxConcurrency ?? 10);
      expect(peaks.poll).toBe(maxConcurrency ?? 10);
      expect(peaks.collect).toBeGreaterThan(0);
      expect(peaks.collect).toBeLessThanOrEqual(maxConcurrency ?? 10);
    },
  );

  test.each([0, -1, 1.5, Infinity, NaN])(
    "rejects invalid concurrency %s",
    (maxConcurrency) => {
      expect(() =>
        defineWorkflowEval("invalid", {
          store: new WorkflowEvalMemoryStore(),
          maxConcurrency,
          data: [],
          task: () => 1,
        }),
      ).toThrow("maxConcurrency must be a positive integer");
    },
  );

  test("webhook record reads stay constant as the dataset grows", async () => {
    const readCounts: number[] = [];
    for (const size of [3, 100]) {
      const store = new WorkflowEvalMemoryStore();
      const read = vi.spyOn(store, "read");
      const f = workflowEval("webhook", store);
      const definition = defineWorkflowEval("indexed-webhooks", {
        store,
        data: Array.from({ length: size }, (_, input) => ({
          id: String(input),
          input,
          expected: input * 2,
        })),
        task: f.task,
        scores: [f.scorer],
      });
      const { runId } = await definition.start({ noSendLogs: true });
      read.mockClear();
      await expect(
        definition.processSubmissionResult({
          runId,
          externalId: "task-0:trial:0",
        }),
      ).resolves.toMatchObject({ pending: { webhook: size } });
      readCounts.push(read.mock.calls.length);
      expect(read.mock.calls.some(([key]) => key.endsWith("/case-ids"))).toBe(
        false,
      );
      await definition.processSubmissionResult({
        runId,
        externalId: "task-0:trial:0",
      });
      await definition.processSubmissionResult({
        runId,
        externalId: "score-0:trial:0",
      });
      await definition.processSubmissionResult({
        runId,
        externalId: "score-0:trial:0",
      });
      read.mockClear();
      await expect(definition.status({ runId })).resolves.toMatchObject({
        pending: { webhook: size - 1 },
      });
      expect(read).toHaveBeenCalledTimes(1);
    }
    expect(readCounts[1]).toBe(readCounts[0]);
    expect(readCounts[1]).toBeLessThan(50);
  });

  test("runs ordinary tasks and scorers", async () => {
    const task = vi.fn((input: number) => input * 2);
    const result = await defineWorkflowEval("local", {
      store: new WorkflowEvalMemoryStore(),
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
    const workflow = defineWorkflowEval("generated-runs", {
      store: new WorkflowEvalMemoryStore(),
      data: [{ input: 1 }],
      task: (input) => input,
      scores: [() => 1],
    });

    const first = await workflow.start({ noSendLogs: true });
    const second = await workflow.start({ noSendLogs: true });

    expect(first.runId).not.toBe(second.runId);
  });

  test("stores run, cases, and individual submissions separately", async () => {
    const values = new Map<string, Uint8Array>();
    const progressStore = new WorkflowEvalMemoryStore();
    const store: WorkflowEvalStore = {
      addToSet: (key, member) => progressStore.addToSet(key, member),
      getSetSize: (key) => progressStore.getSetSize(key),
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
    const { definition } = workflowEval("poll", store);
    await definition.start({ noSendLogs: true });
    const records = [...values]
      .filter(([key]) => !key.includes("/claims/"))
      .map(
        ([key, value]) =>
          [key, JSON.parse(new TextDecoder().decode(value))] as const,
      );
    const run = records.find(([key]) =>
      /^workflow-eval\/v1\/runs\/[^/]+$/.test(key),
    )!;
    expect(run[0]).toMatch(/^workflow-eval\/v1\/runs\//);
    expect(run[1]).toMatchObject({
      caseCount: 3,
    });
    expect(run[1]).not.toHaveProperty("cases");
    expect(run[1]).not.toHaveProperty("submissions");
    const submissions = records.filter(([key]) =>
      key.includes("/submissions/"),
    );
    expect(submissions).toHaveLength(3);
    expect(submissions.map(([, record]) => record.itemIds)).toEqual([
      ["one:trial:0"],
      ["two:trial:0"],
      ["three:trial:0"],
    ]);
    expect(records.filter(([key]) => key.includes("/cases/"))).toHaveLength(3);
  });

  test("polls existing submissions once and starts scoring only ready cases", async () => {
    const f = workflowEval("poll");
    const waiting = await f.definition.start({ noSendLogs: true });
    const options = { runId: waiting.runId };
    expect(waiting).toMatchObject({
      status: "waiting",
      pending: { poll: 3, webhook: 0 },
    });
    expect(f.taskSubmit).toHaveBeenCalledTimes(3);
    await expect(f.definition.status(options)).resolves.toEqual(waiting);
    expect(f.poll).not.toHaveBeenCalled();

    f.ready.add("task-two:trial:0");
    await expect(f.definition.poll(options)).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 3, webhook: 0 },
    });
    expect(f.poll).toHaveBeenCalledTimes(3);
    expect(f.scoreSubmit).toHaveBeenCalledTimes(1);
    expect(f.localScore).toHaveBeenCalledTimes(1);
    expect(f.classifier).toHaveBeenCalledTimes(1);
    expect(f.scoreSubmit.mock.calls[0][0]).toMatchObject({
      id: "two:trial:0",
      output: 4,
    });
    expect(f.localScore.mock.calls[0][0]).toMatchObject({
      input: 2,
      output: 4,
    });

    f.ready.add("score-two:trial:0");
    await expect(f.definition.poll(options)).resolves.toMatchObject({
      status: "waiting",
    });
    expect(f.poll).toHaveBeenCalledTimes(6);
    expect(f.scoreSubmit).toHaveBeenCalledTimes(1);
    expect(f.localScore).toHaveBeenCalledTimes(1);

    f.ready.add("task-one:trial:0");
    f.ready.add("task-three:trial:0");
    await f.definition.poll(options);
    expect(f.scoreSubmit).toHaveBeenCalledTimes(3);
    f.ready.add("score-one:trial:0");
    f.ready.add("score-three:trial:0");
    const completed = await f.definition.poll(options);
    expect(completed).toMatchObject({
      status: "completed",
      pending: { poll: 0, webhook: 0 },
      summary: {
        scores: { workflow_exact: { score: 1 }, extra: { score: 0.5 } },
      },
    });
    const callCount = f.poll.mock.calls.length;
    await expect(f.definition.status(options)).resolves.toEqual(completed);
    await expect(f.definition.poll(options)).resolves.toEqual(completed);
    expect(f.poll).toHaveBeenCalledTimes(callCount);
    expect(f.taskSubmit).toHaveBeenCalledTimes(3);
    expect(f.classifier).toHaveBeenCalledTimes(3);
  });

  test("resumes webhook submissions with a fresh definition and supports both locators", async () => {
    const store = new WorkflowEvalMemoryStore();
    const first = workflowEval("webhook", store);
    const { runId } = await first.definition.start({ noSendLogs: true });
    const f = workflowEval("webhook", store);
    // Simulate fetching provider results in a later process, without rerunning submit.
    for (const [id, job] of first.taskJobs) f.taskJobs.set(id, job);
    const [externalId, { context }] = [...first.taskJobs][1];
    await expect(
      f.definition.processSubmissionResult({
        runId,
        submissionId: context.submissionId,
      }),
    ).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 0, webhook: 3 },
    });
    expect(f.taskSubmit).not.toHaveBeenCalled();
    expect(f.scoreSubmit).toHaveBeenCalledTimes(1);
    expect(f.scoreSubmit.mock.calls[0][0].id).toBe("two:trial:0");
    expect(f.taskCollect.mock.calls[0][1]).toEqual(context);
    await f.definition.processSubmissionResult({ runId, externalId });
    expect(f.taskCollect).toHaveBeenCalledTimes(1);
    expect(f.scoreSubmit).toHaveBeenCalledTimes(1);

    for (const id of first.taskJobs.keys()) {
      await f.definition.processSubmissionResult({ runId, externalId: id });
    }
    for (const id of f.scoreJobs.keys()) {
      await f.definition.processSubmissionResult({ runId, externalId: id });
    }
    const completed = await f.definition.status({ runId });
    expect(completed.status).toBe("completed");
    await expect(
      f.definition.processSubmissionResult({ runId, externalId }),
    ).resolves.toEqual(completed);
    expect(f.taskCollect).toHaveBeenCalledTimes(3);
    expect(f.localScore).toHaveBeenCalledTimes(3);
  });

  test("claims downstream work once across concurrent webhook deliveries", async () => {
    const f = workflowEval("webhook");
    const { runId } = await f.definition.start({ noSendLogs: true });
    let release!: () => void;
    const collecting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    f.taskCollect.mockImplementation(async ({ id }) => {
      if (++count === 2) release();
      await collecting;
      return { output: f.taskJobs.get(id)!.item.input * 2 };
    });
    await Promise.all([
      f.definition.processSubmissionResult({
        runId,
        externalId: "task-one:trial:0",
      }),
      f.definition.processSubmissionResult({
        runId,
        externalId: "task-one:trial:0",
      }),
    ]);
    expect(f.scoreSubmit).toHaveBeenCalledTimes(1);
    expect(f.localScore).toHaveBeenCalledTimes(1);
    expect(f.classifier).toHaveBeenCalledTimes(1);
    await expect(f.definition.status({ runId })).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 0, webhook: 3 },
    });
  });

  test("preserves results across concurrent completion of different cases", async () => {
    const f = workflowEval("webhook");
    const { runId } = await f.definition.start({ noSendLogs: true });
    await Promise.all(
      [...f.taskJobs.keys()].map((externalId) =>
        f.definition.processSubmissionResult({ runId, externalId }),
      ),
    );
    expect(f.scoreSubmit).toHaveBeenCalledTimes(3);
    expect(f.localScore).toHaveBeenCalledTimes(3);
    await Promise.all(
      [...f.scoreJobs.keys()].map((externalId) =>
        f.definition.processSubmissionResult({ runId, externalId }),
      ),
    );
    await expect(f.definition.status({ runId })).resolves.toMatchObject({
      status: "completed",
    });
  });

  test("validates completion locators", async () => {
    const f = workflowEval("webhook");
    const { runId } = await f.definition.start({ noSendLogs: true });
    await expect(
      f.definition.processSubmissionResult({ runId }),
    ).rejects.toThrow("require submissionId or externalId");
    await expect(
      f.definition.processSubmissionResult({ runId, externalId: "missing" }),
    ).rejects.toThrow("No submission matches");
    await expect(
      f.definition.processSubmissionResult({
        runId: "missing",
        externalId: "task-one:trial:0",
      }),
    ).rejects.toThrow("run missing is missing");
    const submissionId = [...f.taskJobs.values()][0].context.submissionId;
    await expect(
      f.definition.processSubmissionResult({
        runId,
        submissionId,
        externalId: "task-two:trial:0",
      }),
    ).rejects.toThrow("identify different submissions");
    expect(f.taskCollect).not.toHaveBeenCalled();
  });

  test("propagates callback errors and polling failures", async () => {
    const f = workflowEval("poll");
    const { runId } = await f.definition.start({ noSendLogs: true });
    f.poll.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(f.definition.poll({ runId })).rejects.toThrow(
      "provider unavailable",
    );
    f.poll.mockResolvedValueOnce({
      status: "failed",
      error: "provider failed",
    });
    await expect(f.definition.poll({ runId })).rejects.toThrow(
      "provider failed",
    );
    expect(f.taskCollect).not.toHaveBeenCalled();
    f.ready.add("task-one:trial:0");
    f.taskCollect.mockRejectedValueOnce(new Error("collection failed"));
    await expect(f.definition.poll({ runId })).rejects.toThrow(
      "collection failed",
    );
    expect(f.scoreSubmit).not.toHaveBeenCalled();
  });

  test("rejects array collection results", async () => {
    const f = workflowEval("webhook");
    const { runId } = await f.definition.start({ noSendLogs: true });
    // Exercise the runtime boundary for JavaScript consumers.
    // @ts-expect-error Collection returns one result envelope, never an array.
    f.taskCollect.mockResolvedValueOnce([{ output: 2 }]);
    await expect(
      f.definition.processSubmissionResult({
        runId,
        externalId: "task-one:trial:0",
      }),
    ).rejects.toThrow("must return a result object");
    await f.definition.processSubmissionResult({
      runId,
      externalId: "task-one:trial:0",
    });
    // @ts-expect-error Score arrays must be nested inside the score envelope.
    f.scoreCollect.mockResolvedValueOnce([{ score: 1 }]);
    await expect(
      f.definition.processSubmissionResult({
        runId,
        externalId: "score-one:trial:0",
      }),
    ).rejects.toThrow("must return a result object");
  });

  test("propagates metadata, tags, parameters, and distinct trials", async () => {
    type Metadata = { fromCase?: boolean; fromTask?: boolean };
    const items: WorkflowTaskItem<
      number,
      number,
      Metadata,
      Record<string, never>
    >[] = [];
    const contexts: Array<{ runId: string; submissionId: string }> = [];
    const scoreItems: WorkflowScorerItem<number, number, number, Metadata>[] =
      [];
    const task = new WorkflowTask<
      number,
      number,
      number,
      Metadata,
      Record<string, never>,
      { input: number }
    >({
      async submit(item, context) {
        items.push(item);
        contexts.push(context);
        return { input: item.input };
      },
      completion: {
        mode: "poll",
        async poll() {
          return { status: "complete" };
        },
      },
      async collect({ input }) {
        return {
          output: input * 2,
          metadata: { fromTask: true },
          tags: ["updated"],
        };
      },
    });
    const scorer = new WorkflowScorer<number, number, number, Metadata>({
      name: "__proto__",
      async submit(item) {
        scoreItems.push(item);
        return null;
      },
      completion: {
        mode: "poll",
        async poll() {
          return { status: "complete" };
        },
      },
      async collect() {
        return { score: 1 };
      },
    });
    const localScore = vi.fn(({ metadata, tags }) => {
      expect(metadata).toEqual({ fromCase: true, fromTask: true });
      expect(tags).toEqual(["updated"]);
      return 1;
    });
    const definition = defineWorkflowEval("trials", {
      store: new WorkflowEvalMemoryStore(),
      data: [
        {
          input: 2,
          expected: 4,
          metadata: { fromCase: true },
          tags: ["original"],
        },
      ],
      caseId: () => "one",
      trialCount: 2,
      task,
      scores: [scorer, localScore],
    });
    const { runId } = await definition.start({ noSendLogs: true });
    expect(items.map(({ id, trialIndex }) => ({ id, trialIndex }))).toEqual([
      { id: "one:trial:0", trialIndex: 0 },
      { id: "one:trial:1", trialIndex: 1 },
    ]);
    expect(items[0]).toMatchObject({
      input: 2,
      expected: 4,
      parameters: {},
      tags: ["original"],
    });
    expect(new Set(contexts.map(({ submissionId }) => submissionId)).size).toBe(
      2,
    );
    await definition.poll({ runId });
    expect(scoreItems).toHaveLength(2);
    expect(scoreItems[0]).toMatchObject({
      metadata: { fromCase: true, fromTask: true },
      tags: ["updated"],
      output: 4,
    });
    const result = await definition.poll({ runId });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Eval did not complete");
    expect(Object.hasOwn(result.summary.scores, "__proto__")).toBe(true);
    expect(result.summary.scores.__proto__?.score).toBe(1);
  });

  test("supports ordinary tasks with workflow scorers and empty workflow datasets", async () => {
    const f = workflowEval("poll");
    const definition = defineWorkflowEval("ordinary-task", {
      store: new WorkflowEvalMemoryStore(),
      data: [{ id: "one", input: 2, expected: 4 }],
      task: (input) => input * 2,
      scores: [f.scorer],
    });
    const { runId } = await definition.start({ noSendLogs: true });
    expect(f.scoreSubmit.mock.calls[0][0]).toMatchObject({
      input: 2,
      output: 4,
    });
    f.ready.add("score-one:trial:0");
    await expect(definition.poll({ runId })).resolves.toMatchObject({
      status: "completed",
    });
    await expect(
      defineWorkflowEval("empty", {
        store: new WorkflowEvalMemoryStore(),
        data: [],
        task: f.task,
        scores: [f.scorer],
      }).start({ noSendLogs: true }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(f.taskSubmit).not.toHaveBeenCalled();
  });

  test("keeps task-only runs waiting until every task completes", async () => {
    const f = workflowEval("webhook");
    const definition = defineWorkflowEval("task-only", {
      store: new WorkflowEvalMemoryStore(),
      data: [
        { id: "one", input: 1, expected: 2 },
        { id: "two", input: 2, expected: 4 },
      ],
      task: f.task,
    });
    const { runId } = await definition.start({ noSendLogs: true });
    await expect(
      definition.processSubmissionResult({
        runId,
        externalId: "task-one:trial:0",
      }),
    ).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 0, webhook: 1 },
    });
    await expect(
      definition.processSubmissionResult({
        runId,
        externalId: "task-two:trial:0",
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  test("mixes polling tasks with webhook scorers", async () => {
    const f = workflowEval("poll");
    f.scorer.processor.completion = {
      mode: "webhook",
      getExternalId: ({ id }) => id,
    };
    const { runId } = await f.definition.start({ noSendLogs: true });
    f.ready.add("task-one:trial:0");
    await expect(f.definition.poll({ runId })).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 2, webhook: 1 },
    });
    await expect(
      f.definition.processSubmissionResult({
        runId,
        externalId: "score-one:trial:0",
      }),
    ).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 2, webhook: 0 },
    });
    expect(f.poll).toHaveBeenCalledTimes(3);
    for (const [id, { context }] of f.taskJobs) {
      expect(f.poll).toHaveBeenCalledWith({ id }, context);
    }
  });

  test("requires stable case ids", async () => {
    const f = workflowEval("poll");
    await expect(
      defineWorkflowEval("missing-ids", {
        store: new WorkflowEvalMemoryStore(),
        data: [{ input: 1, expected: 2 }],
        task: f.task,
      }).start({ noSendLogs: true }),
    ).rejects.toThrow("requires id, upsert_id, or caseId");
  });

  test("infers submission data and callback result types", () => {
    const task = new WorkflowTask({
      async submit(
        item: WorkflowTaskItem<string, void, void, Record<string, never>>,
      ) {
        expectTypeOf(item.input).toEqualTypeOf<string>();
        return { providerId: "request", attempt: 1 };
      },
      completion: {
        mode: "webhook",
        getExternalId(submission) {
          expectTypeOf(submission).toEqualTypeOf<{
            providerId: string;
            attempt: number;
          }>();
          return submission.providerId;
        },
      },
      async collect(submission) {
        return { output: submission.attempt };
      },
    });
    expectTypeOf(task.processor.collect).returns.resolves.toMatchTypeOf<{
      output: number;
    }>();
    const scorer = new WorkflowScorer({
      name: "score",
      async submit() {
        return { providerId: "score" };
      },
      completion: {
        mode: "poll",
        async poll(submission) {
          expectTypeOf(submission).toEqualTypeOf<{ providerId: string }>();
          return { status: "pending" };
        },
      },
      async collect(submission) {
        expectTypeOf(submission.providerId).toEqualTypeOf<string>();
        return { score: 1 };
      },
    });
    expect(scorer.name).toBe("score");
  });
});

describe("workflow batch evals", () => {
  test("groups tasks and scorers into provider batches", async () => {
    const f = batchEval({ taskSize: 2, scoreSize: 3, cases: 5 });
    const { runId } = await f.definition.start({ noSendLogs: true });
    expect(f.taskSubmit).toHaveBeenCalledTimes(3);
    expect(f.taskBatches.map((items) => items.map(({ id }) => id))).toEqual([
      ["0:trial:0", "1:trial:0"],
      ["2:trial:0", "3:trial:0"],
      ["4:trial:0"],
    ]);
    expect(f.taskBatches[0].map(({ customId }) => customId)).toEqual([
      "item-0",
      "item-1",
    ]);
    await expect(f.definition.status({ runId })).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 0, webhook: 3 },
    });

    // A partial scorer batch waits while more tasks can still complete.
    await f.definition.processSubmissionResult({ externalId: "task-batch-1" });
    expect(f.localScore).toHaveBeenCalledTimes(2);
    expect(f.scoreSubmit).not.toHaveBeenCalled();

    // Repeated deliveries submit the next full batch only once.
    await Promise.all([
      f.definition.processSubmissionResult({ externalId: "task-batch-2" }),
      f.definition.processSubmissionResult({ externalId: "task-batch-2" }),
    ]);
    expect(f.scoreSubmit).toHaveBeenCalledTimes(1);
    expect(f.scoreBatches[0].map(({ id, output }) => [id, output])).toEqual([
      ["0:trial:0", 0],
      ["1:trial:0", 2],
      ["2:trial:0", 4],
    ]);

    // The last task batch closes the stage and flushes the remainder.
    await f.definition.processSubmissionResult({ externalId: "task-batch-3" });
    expect(f.scoreSubmit).toHaveBeenCalledTimes(2);
    expect(f.scoreBatches[1].map(({ id }) => id)).toEqual([
      "3:trial:0",
      "4:trial:0",
    ]);
    expect(f.taskCollect).toHaveBeenCalledTimes(4);

    await f.definition.processSubmissionResult({ externalId: "score-batch-1" });
    const completed = await f.definition.processSubmissionResult({
      runId,
      externalId: "score-batch-2",
    });
    expect(completed).toMatchObject({
      status: "completed",
      pending: { poll: 0, webhook: 0 },
      summary: { scores: { batch_exact: { score: 1 }, local: { score: 1 } } },
    });
    expect(f.localScore).toHaveBeenCalledTimes(5);
  });

  test("records item failures without blocking the run", async () => {
    const f = batchEval({ taskSize: 4, scoreSize: 4, cases: 4 });
    f.taskResults.mockImplementation((items) => [
      { customId: items[0].customId, result: { output: items[0].input * 2 } },
      { customId: items[1].customId, error: new Error("rate limited") },
      // items[2] is missing, as in a partially expired provider batch.
      { customId: items[3].customId, result: { output: items[3].input * 2 } },
    ]);
    f.scoreResults.mockImplementation((items) => [
      { customId: items[0].customId, result: { score: 1 } },
      { customId: items[1].customId, error: { type: "overloaded" } },
    ]);
    const { runId } = await f.definition.start({ noSendLogs: true });
    await f.definition.processSubmissionResult({ externalId: "task-batch-1" });
    expect(f.scoreBatches).toHaveLength(1);
    expect(f.scoreBatches[0].map(({ id }) => id)).toEqual([
      "0:trial:0",
      "3:trial:0",
    ]);
    expect(f.localScore).toHaveBeenCalledTimes(2);
    const result = await f.definition.processSubmissionResult({
      runId,
      externalId: "score-batch-1",
    });
    expect(result).toMatchObject({
      status: "completed",
      summary: { scores: { batch_exact: { score: 1 }, local: { score: 1 } } },
    });
  });

  test("submits partial scorer batches after maxWaitMs", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const f = workflowEval("poll");
      const scoreSubmit = vi.fn(async (_items: Array<{ id: string }>) => ({
        id: "score-batch",
      }));
      const definition = defineWorkflowEval("batch-wait", {
        store: new WorkflowEvalMemoryStore(),
        data: ["one", "two", "three"].map((id, index) => ({
          id,
          input: index + 1,
          expected: (index + 1) * 2,
        })),
        task: f.task,
        scores: [
          new WorkflowBatchScorer<number, number, number, void, { id: string }>(
            {
              name: "batch_judge",
              batching: { maxSize: 10, maxWaitMs: 500 },
              submit: scoreSubmit,
              completion: {
                mode: "poll",
                poll: async () => ({ status: "pending" }),
              },
              collect: () => [],
            },
          ),
        ],
      });
      const { runId } = await definition.start({ noSendLogs: true });
      f.ready.add("task-one:trial:0");
      await definition.poll({ runId });
      now.mockReturnValue(1_499);
      await definition.poll({ runId });
      expect(scoreSubmit).not.toHaveBeenCalled();
      f.ready.add("task-two:trial:0");
      now.mockReturnValue(1_500);
      await definition.poll({ runId });
      expect(scoreSubmit).toHaveBeenCalledTimes(1);
      expect(scoreSubmit.mock.calls[0][0].map(({ id }) => id)).toEqual([
        "one:trial:0",
        "two:trial:0",
      ]);
      // A new window starts for items that become ready after a batch.
      f.ready.add("task-three:trial:0");
      now.mockReturnValue(1_600);
      await definition.poll({ runId });
      expect(scoreSubmit).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  test("polls batches and supports async iterable results", async () => {
    const statuses = new Map<string, "pending" | "complete">();
    const task = new WorkflowBatchTask<
      number,
      number,
      void,
      void,
      Record<string, never>,
      { id: string; items: Array<{ customId: string; input: number }> }
    >({
      batching: { maxSize: 10 },
      async submit(items) {
        const id = `batch-${statuses.size}`;
        statuses.set(id, "pending");
        return {
          id,
          items: items.map(({ customId, input }) => ({ customId, input })),
        };
      },
      completion: {
        mode: "poll",
        async poll({ id }) {
          return { status: statuses.get(id)! };
        },
      },
      async *collect({ items }) {
        for (const { customId, input } of items) {
          yield { customId, result: { output: input + 1 } };
        }
      },
    });
    const definition = defineWorkflowEval("batch-poll", {
      store: new WorkflowEvalMemoryStore(),
      data: [1, 2, 3].map((input) => ({ id: String(input), input })),
      task,
      scores: [({ output, input }) => (output === input + 1 ? 1 : 0)],
    });
    const { runId } = await definition.start({ noSendLogs: true });
    await expect(definition.poll({ runId })).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 1, webhook: 0 },
    });
    statuses.set("batch-0", "complete");
    await expect(definition.poll({ runId })).resolves.toMatchObject({
      status: "completed",
      summary: { scores: { scorer_0: { score: 1 } } },
    });
  });

  test("rejects unknown and duplicate custom ids", async () => {
    const f = batchEval({ taskSize: 2, scoreSize: 2, cases: 2 });
    await f.definition.start({ noSendLogs: true });
    f.taskResults.mockImplementationOnce(() => [
      { customId: "item-9", result: { output: 1 } },
    ]);
    await expect(
      f.definition.processSubmissionResult({ externalId: "task-batch-1" }),
    ).rejects.toThrow("returned unknown customId item-9");
    f.taskResults.mockImplementationOnce((items) => [
      { customId: items[0].customId, result: { output: 0 } },
      { customId: items[0].customId, result: { output: 0 } },
    ]);
    await expect(
      f.definition.processSubmissionResult({ externalId: "task-batch-1" }),
    ).rejects.toThrow("returned customId item-0 more than once");
    await f.definition.processSubmissionResult({ externalId: "task-batch-1" });
    expect(f.scoreSubmit).toHaveBeenCalledTimes(1);
  });

  test("retries failed batch submissions on poll", async () => {
    const f = batchEval({ taskSize: 2, scoreSize: 2, cases: 3 });
    f.taskSubmit.mockRejectedValueOnce(new Error("rate limited"));
    await expect(f.definition.start({ noSendLogs: true })).rejects.toThrow(
      "rate limited",
    );
    const { runId } = f.taskSubmit.mock.calls[0][1];
    await expect(f.definition.status({ runId })).resolves.toMatchObject({
      status: "waiting",
      pending: { poll: 0, webhook: 2 },
    });
    await expect(
      f.definition.processSubmissionResult({
        runId,
        submissionId: f.taskSubmit.mock.calls[0][1].submissionId,
      }),
    ).rejects.toThrow("failed to submit; poll() retries it");

    await f.definition.poll({ runId });
    expect(f.taskSubmit).toHaveBeenCalledTimes(3);
    // The retry reuses the submission, so its ID can serve as an idempotency key.
    expect(f.taskSubmit.mock.calls[2][1]).toEqual(
      f.taskSubmit.mock.calls[0][1],
    );
    expect(f.taskSubmit.mock.calls[2][0].map(({ id }) => id)).toEqual(
      f.taskSubmit.mock.calls[0][0].map(({ id }) => id),
    );
    // A successful retry is not submitted again.
    await f.definition.poll({ runId });
    expect(f.taskSubmit).toHaveBeenCalledTimes(3);

    await f.definition.processSubmissionResult({ externalId: "task-batch-1" });
    await f.definition.processSubmissionResult({ externalId: "task-batch-2" });
    await f.definition.processSubmissionResult({ externalId: "score-batch-1" });
    await expect(
      f.definition.processSubmissionResult({ externalId: "score-batch-2" }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  test("retries failed single-item submissions on poll", async () => {
    const f = workflowEval("webhook");
    f.taskSubmit.mockRejectedValueOnce(new Error("rate limited"));
    await expect(f.definition.start({ noSendLogs: true })).rejects.toThrow(
      "rate limited",
    );
    const { runId } = f.taskSubmit.mock.calls[0][1];
    await expect(f.definition.status({ runId })).resolves.toMatchObject({
      pending: { poll: 0, webhook: 3 },
    });
    await f.definition.poll({ runId });
    expect(f.taskSubmit).toHaveBeenCalledTimes(4);
    expect(f.taskSubmit.mock.calls[3][1]).toEqual(
      f.taskSubmit.mock.calls[0][1],
    );
    await expect(
      f.definition.processSubmissionResult({
        externalId: `task-${f.taskSubmit.mock.calls[0][0].id}`,
      }),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  test("requires runId for externalIds shared by several runs", async () => {
    const f = workflowEval("webhook");
    const first = await f.definition.start({ noSendLogs: true });
    const second = await f.definition.start({ noSendLogs: true });
    await expect(
      f.definition.processSubmissionResult({ externalId: "task-one:trial:0" }),
    ).rejects.toThrow("matches several runs; pass runId");
    for (const { runId } of [first, second]) {
      await expect(
        f.definition.processSubmissionResult({
          runId,
          externalId: "task-one:trial:0",
        }),
      ).resolves.toMatchObject({ status: "waiting" });
    }
  });

  test("validates batching options and run locators", async () => {
    const processor = {
      submit: async () => null,
      completion: {
        mode: "poll" as const,
        poll: async () => ({ status: "pending" as const }),
      },
      collect: () => [],
    };
    expect(
      () => new WorkflowBatchTask({ ...processor, batching: { maxSize: 0 } }),
    ).toThrow("batching.maxSize must be a positive integer");
    expect(
      () =>
        new WorkflowBatchScorer({
          ...processor,
          name: "score",
          batching: { maxSize: 1, maxWaitMs: -1 },
        }),
    ).toThrow("batching.maxWaitMs must be a non-negative number");

    const f = workflowEval("webhook");
    await f.definition.start({ noSendLogs: true });
    await expect(
      f.definition.processSubmissionResult({ submissionId: "submission" }),
    ).rejects.toThrow("with a submissionId require runId");
    await expect(
      f.definition.processSubmissionResult({ externalId: "missing" }),
    ).rejects.toThrow("No submission matches");
    // Single-item webhook submissions can omit runId too.
    await expect(
      f.definition.processSubmissionResult({ externalId: "task-one:trial:0" }),
    ).resolves.toMatchObject({ status: "waiting" });
    expect(f.taskCollect).toHaveBeenCalledTimes(1);
  });

  test("infers batch submission data and item types", () => {
    const task = new WorkflowBatchTask({
      batching: { maxSize: 2 },
      async submit(
        items: WorkflowBatchItem<
          WorkflowTaskItem<string, void, void, Record<string, never>>
        >[],
      ) {
        expectTypeOf(items[0].customId).toEqualTypeOf<string>();
        expectTypeOf(items[0].input).toEqualTypeOf<string>();
        return { batchId: "batch" };
      },
      completion: {
        mode: "webhook",
        getExternalId(submission) {
          expectTypeOf(submission).toEqualTypeOf<{ batchId: string }>();
          return submission.batchId;
        },
      },
      async *collect(submission) {
        yield { customId: submission.batchId, result: { output: 1 } };
      },
    });
    expect(task.processor.batching.maxSize).toBe(2);
    new WorkflowBatchTask({
      // @ts-expect-error Tasks submit every case at start, so they never wait.
      batching: { maxSize: 2, maxWaitMs: 1 },
      submit: async () => null,
      completion: {
        mode: "poll",
        poll: async () => ({ status: "pending" as const }),
      },
      collect: () => [],
    });
  });
});

function batchEval({
  taskSize,
  scoreSize,
  cases,
}: {
  taskSize: number;
  scoreSize: number;
  cases: number;
}) {
  type TaskItem = WorkflowBatchItem<
    WorkflowTaskItem<number, number, void, Record<string, never>>
  >;
  type ScoreItem = WorkflowBatchItem<
    WorkflowScorerItem<number, number, number, void>
  >;
  const taskBatches: TaskItem[][] = [];
  const scoreBatches: ScoreItem[][] = [];
  const taskResults = vi.fn(
    (items: TaskItem[]): WorkflowBatchItemResult<{ output: number }>[] =>
      items.map(({ customId, input }) => ({
        customId,
        result: { output: input * 2 },
      })),
  );
  const scoreResults = vi.fn(
    (items: ScoreItem[]): WorkflowBatchItemResult<{ score: number }>[] =>
      items.map(({ customId, output, expected }) => ({
        customId,
        result: { score: output === expected ? 1 : 0 },
      })),
  );
  const completion = {
    mode: "webhook" as const,
    getExternalId: ({ id }: { id: string }) => id,
  };
  const taskSubmit = vi.fn(async (items: TaskItem[]) => {
    taskBatches.push(items);
    return { id: `task-batch-${taskBatches.length}` };
  });
  const taskCollect = vi.fn(async ({ id }: { id: string }) =>
    taskResults(taskBatches[Number(id.split("-").at(-1)) - 1]),
  );
  const scoreSubmit = vi.fn(async (items: ScoreItem[]) => {
    scoreBatches.push(items);
    return { id: `score-batch-${scoreBatches.length}` };
  });
  const localScore = vi.fn(
    ({ output, expected }: { output: number; expected: number }) =>
      output === expected ? 1 : 0,
  );
  const definition = defineWorkflowEval("batch", {
    store: new WorkflowEvalMemoryStore(),
    data: Array.from({ length: cases }, (_, input) => ({
      id: String(input),
      input,
      expected: input * 2,
    })),
    task: new WorkflowBatchTask<
      number,
      number,
      number,
      void,
      Record<string, never>,
      { id: string }
    >({
      batching: { maxSize: taskSize },
      submit: taskSubmit,
      completion,
      collect: taskCollect,
    }),
    scores: [
      new WorkflowBatchScorer<number, number, number, void, { id: string }>({
        name: "batch_exact",
        batching: { maxSize: scoreSize },
        submit: scoreSubmit,
        completion,
        async collect({ id }) {
          return scoreResults(scoreBatches[Number(id.split("-").at(-1)) - 1]);
        },
      }),
      Object.defineProperty(localScore, "name", { value: "local" }),
    ],
  });
  return {
    definition,
    taskBatches,
    scoreBatches,
    taskResults,
    scoreResults,
    taskSubmit,
    taskCollect,
    scoreSubmit,
    localScore,
  };
}

function workflowEval(
  mode: "poll" | "webhook",
  store: WorkflowEvalStore = new WorkflowEvalMemoryStore(),
) {
  type TaskItem = WorkflowTaskItem<number, number, void, Record<string, never>>;
  type ScoreItem = WorkflowScorerItem<number, number, number, void>;
  type Context = { runId: string; submissionId: string };
  const taskJobs = new Map<string, { item: TaskItem; context: Context }>();
  const scoreJobs = new Map<string, { item: ScoreItem; context: Context }>();
  const ready = new Set<string>();
  const poll = vi.fn(
    async ({
      id,
    }: {
      id: string;
    }): Promise<
      | { status: "pending" }
      | { status: "complete" }
      | { status: "failed"; error: unknown }
    > => ({ status: ready.has(id) ? "complete" : "pending" }),
  );
  const completion =
    mode === "poll"
      ? { mode, poll }
      : { mode, getExternalId: ({ id }: { id: string }) => id };
  const taskSubmit = vi.fn(async (item: TaskItem, context: Context) => {
    const id = `task-${item.id}`;
    taskJobs.set(id, { item, context });
    return { id };
  });
  const taskCollect = vi.fn(
    async ({ id }: { id: string }, _context: Context) => ({
      output: taskJobs.get(id)!.item.input * 2,
    }),
  );
  const task = new WorkflowTask<
    number,
    number,
    number,
    void,
    Record<string, never>,
    { id: string }
  >({
    submit: taskSubmit,
    completion,
    collect: taskCollect,
  });
  const scoreSubmit = vi.fn(async (item: ScoreItem, context: Context) => {
    const id = `score-${item.id}`;
    scoreJobs.set(id, { item, context });
    return { id };
  });
  const scoreCollect = vi.fn(async ({ id }: { id: string }) => {
    const { item } = scoreJobs.get(id)!;
    return {
      score: [
        {
          name: "workflow_exact",
          score: item.output === item.expected ? 1 : 0,
        },
        { name: "extra", score: 0.5 },
      ],
    };
  });
  const scorer = new WorkflowScorer<
    number,
    number,
    number,
    void,
    { id: string }
  >({
    name: "workflow_exact",
    submit: scoreSubmit,
    completion,
    collect: scoreCollect,
  });
  const localScore = vi.fn(
    ({
      output,
      expected,
    }: {
      input: number;
      output: number;
      expected: number;
    }) => (output === expected ? 1 : 0),
  );
  const classifier = vi.fn(() => ({
    name: "quality",
    id: "pass",
    label: "Pass",
  }));
  const definition = defineWorkflowEval("workflow", {
    store,
    data: ["one", "two", "three"].map((id, index) => ({
      id,
      input: index + 1,
      expected: (index + 1) * 2,
    })),
    task,
    scores: [scorer, localScore],
    classifiers: [classifier],
  });
  return {
    definition,
    task,
    scorer,
    taskJobs,
    scoreJobs,
    ready,
    poll,
    taskSubmit,
    taskCollect,
    scoreSubmit,
    scoreCollect,
    localScore,
    classifier,
  };
}
