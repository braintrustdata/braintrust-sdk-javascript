import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { configureNode } from "./node/config";
import {
  WorkflowScorer,
  WorkflowTask,
  defineWorkflowEval,
  WorkflowEvalMemoryStore,
  WorkflowEvalRedisStore,
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
    expect(submissions.map(([, record]) => record.itemId)).toEqual([
      "one:trial:0",
      "two:trial:0",
      "three:trial:0",
    ]);
    for (const [, record] of submissions)
      expect(record).not.toHaveProperty("itemIds");
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
