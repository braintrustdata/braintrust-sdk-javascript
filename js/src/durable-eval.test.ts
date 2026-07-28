import { describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BatchScorer,
  BatchTask,
  DurableEval,
  FileDurableEvalStore,
  MemoryDurableEvalStore,
  type DurableBatchTaskItem,
  type DurableEvalStore,
  type DurableEvalWriteCondition,
} from "./durable-eval";
import type { EvaluatorFile } from "./framework";
import { configureNode } from "./node/config";

configureNode();

describe("DurableEval", () => {
  test("filesystem store enforces compare-and-set writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-eval-store-"));
    try {
      const store = new FileDurableEvalStore(directory);
      const first = await store.write(
        "runs/one",
        new TextEncoder().encode("one"),
        { ifAbsent: true },
      );
      expect(first.written).toBe(true);
      if (!first.written) throw new Error("initial write failed");

      await expect(
        store.write("runs/one", new TextEncoder().encode("two"), {
          ifAbsent: true,
        }),
      ).resolves.toMatchObject({ written: false });
      await expect(
        store.write("runs/one", new TextEncoder().encode("two"), {
          ifVersion: "wrong",
        }),
      ).resolves.toMatchObject({ written: false });

      const updated = await store.write(
        "runs/one",
        new TextEncoder().encode("two"),
        { ifVersion: first.version },
      );
      expect(updated.written).toBe(true);
      expect(
        new TextDecoder().decode((await store.read("runs/one"))?.value),
      ).toBe("two");
      const keys: string[] = [];
      for await (const key of store.list("runs/")) keys.push(key);
      expect(keys).toEqual(["runs/one"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("filesystem store recovers stale locks and rejects Windows traversal keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-eval-locks-"));
    try {
      const store = new FileDurableEvalStore(directory);
      const value = new TextEncoder().encode("one");
      const first = await store.write("runs/one", value, { ifAbsent: true });
      expect(first.written).toBe(true);

      const lockPath = join(directory, "runs", "one.lock");
      await writeFile(lockPath, "orphaned");
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(lockPath, staleTime, staleTime);
      const current = await store.read("runs/one");
      await expect(
        store.write("runs/one", new TextEncoder().encode("two"), {
          ifVersion: current!.version,
        }),
      ).resolves.toMatchObject({ written: true });

      await expect(
        store.write("..\\outside", value, { ifAbsent: true }),
      ).rejects.toThrow("Invalid durable eval store key");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("runs local tasks and scorers and resumes completed work", async () => {
    const store = new MemoryDurableEvalStore();
    const task = vi.fn((input: number) => input * 2);
    let scorerCalls = 0;
    function exact({
      output,
      expected,
    }: {
      output: number;
      expected?: number;
    }) {
      scorerCalls++;
      return output === expected ? 1 : 0;
    }
    const definition = {
      revision: "v1",
      data: [
        { id: "one", input: 1, expected: 2 },
        { id: "two", input: 2, expected: 4 },
      ],
      task,
      scores: [exact],
    };

    const durable = DurableEval("durable-local", definition);
    const first = await durable.run({
      runId: "run-1",
      store,
      noSendLogs: true,
    });
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("run did not complete");
    expect(first.summary.scores.exact?.score).toBe(1);
    expect(first.progress).toMatchObject({
      total: 2,
      taskSucceeded: 2,
      scoreSucceeded: 2,
    });

    const second = await durable.run({
      runId: "run-1",
      store,
      noSendLogs: true,
    });
    expect(second.status).toBe("completed");
    expect(task).toHaveBeenCalledTimes(2);
    expect(scorerCalls).toBe(2);
  });

  test("persists metadata written through hooks.meta", async () => {
    const result = await DurableEval("metadata-hooks", {
      revision: "v1",
      data: [
        {
          id: "one",
          input: "hello",
          metadata: { source: "initial" },
        },
      ],
      task: (_input, hooks) => {
        hooks.meta({ source: "deprecated-hook" });
        return hooks.metadata.source;
      },
      scores: [
        function exact({ output }) {
          return output === "deprecated-hook" ? 1 : 0;
        },
      ],
    }).run({
      runId: "metadata-run",
      store: new MemoryDurableEvalStore(),
      noSendLogs: true,
    });

    expect(result).toMatchObject({
      status: "completed",
      summary: { scores: { exact: { score: 1 } } },
    });
  });

  test("requires stable case identifiers", async () => {
    await expect(
      DurableEval("missing-ids", {
        revision: "v1",
        data: [{ input: "hello", expected: "hello" }],
        task: (input) => input,
        scores: [
          function exact({ output, expected }) {
            return output === expected ? 1 : 0;
          },
        ],
      }).run({
        runId: "missing",
        store: new MemoryDurableEvalStore(),
        noSendLogs: true,
      }),
    ).rejects.toThrow("must have a non-empty id");
  });

  test("submits and collects batch tasks and batch scorers", async () => {
    const store = new MemoryDurableEvalStore();
    const taskJobs = new Map<
      string,
      DurableBatchTaskItem<number, number, void, Record<string, never>>[]
    >();
    const task = BatchTask<
      number,
      number,
      number,
      void,
      Record<string, never>,
      { jobId: string }
    >({
      revision: "task-v1",
      batchSize: 2,
      async submit(items, context) {
        taskJobs.set(context.batchId, items);
        return { jobId: context.batchId };
      },
      completion: {
        mode: "poll",
        async poll() {
          return { status: "complete" };
        },
      },
      async *collect(handle) {
        for (const item of taskJobs.get(handle.jobId) ?? []) {
          yield { id: item.id, output: item.input * 2 };
        }
      },
    });
    const scoreJobs = new Map<
      string,
      Array<{ id: string; output: number; expected: number }>
    >();
    const scorer = BatchScorer<number, number, number, void, { jobId: string }>(
      {
        name: "exact",
        revision: "score-v1",
        batchSize: 2,
        async submit(items, context) {
          scoreJobs.set(
            context.batchId,
            items.map((item) => ({
              id: item.id,
              output: item.output,
              expected: item.expected,
            })),
          );
          return { jobId: context.batchId };
        },
        completion: {
          mode: "poll",
          async poll() {
            return { status: "complete" };
          },
        },
        async *collect(handle) {
          for (const item of scoreJobs.get(handle.jobId) ?? []) {
            yield {
              id: item.id,
              score: item.output === item.expected ? 1 : 0,
            };
          }
        },
      },
    );

    const result = await DurableEval("durable-batches", {
      revision: "eval-v1",
      data: [
        { id: "one", input: 1, expected: 2 },
        { id: "two", input: 2, expected: 4 },
        { id: "three", input: 3, expected: 6 },
      ],
      task,
      scores: [scorer],
    }).run({
      runId: "batch-run",
      store,
      noSendLogs: true,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("run did not complete");
    expect(result.summary.scores.exact?.score).toBe(1);
    expect(taskJobs).toHaveLength(2);
    expect(scoreJobs).toHaveLength(2);
  });

  test("retries raced case writes before completing a batch job", async () => {
    class FailOneResultWriteStore implements DurableEvalStore {
      readonly inner = new MemoryDurableEvalStore();
      failed = false;

      read(key: string) {
        return this.inner.read(key);
      }

      async write(
        key: string,
        value: Uint8Array,
        condition: DurableEvalWriteCondition,
      ) {
        const serialized = new TextDecoder().decode(value);
        if (
          !this.failed &&
          key.includes("/cases/") &&
          serialized.includes('"status":"succeeded"')
        ) {
          this.failed = true;
          return {
            written: false as const,
            currentVersion: (await this.inner.read(key))?.version,
          };
        }
        return this.inner.write(key, value, condition);
      }

      list(prefix: string) {
        return this.inner.list(prefix);
      }
    }

    const store = new FailOneResultWriteStore();
    const result = await DurableEval("cas-batch-results", {
      revision: "eval-v1",
      data: [{ id: "one", input: 1, expected: 2 }],
      task: BatchTask<
        number,
        number,
        number,
        void,
        Record<string, never>,
        { id: string }
      >({
        revision: "task-v1",
        async submit() {
          return { id: "provider-job" };
        },
        completion: {
          mode: "poll",
          async poll() {
            return { status: "complete" };
          },
        },
        async *collect() {
          yield { id: "one:trial:0", output: 2 };
        },
      }),
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
      ],
    }).run({
      runId: "cas-run",
      store,
      noSendLogs: true,
    });

    expect(store.failed).toBe(true);
    expect(result).toMatchObject({
      status: "completed",
      progress: { taskSucceeded: 1, scoreSucceeded: 1 },
    });
  });

  test("pauses for webhooks and processes bounded sub-batches", async () => {
    const store = new MemoryDurableEvalStore();
    const providerJobs = new Map<
      string,
      DurableBatchTaskItem<number, number, void, Record<string, never>>[]
    >();
    const submittedSizes: number[] = [];
    const task = BatchTask<
      number,
      number,
      number,
      void,
      Record<string, never>,
      { id: string }
    >({
      revision: "task-v1",
      batchSize: 2,
      maxConcurrentBatches: 2,
      async submit(items) {
        const id = `provider-${providerJobs.size + 1}`;
        providerJobs.set(id, items);
        submittedSizes.push(items.length);
        return { id };
      },
      completion: {
        mode: "webhook",
        source: "openai",
        externalId: (handle) => handle.id,
      },
      async *collect(handle) {
        for (const item of providerJobs.get(handle.id) ?? []) {
          yield { id: item.id, output: item.input * 2 };
        }
      },
    });
    const durable = DurableEval("webhook-batches", {
      revision: "eval-v1",
      data: [
        { id: "one", input: 1, expected: 2 },
        { id: "two", input: 2, expected: 4 },
        { id: "three", input: 3, expected: 6 },
      ],
      task,
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
      ],
    });

    const waiting = await durable.run({
      runId: "webhook-run",
      store,
      noSendLogs: true,
    });
    expect(waiting).toMatchObject({
      status: "paused",
      reason: "waiting_for_webhook",
    });
    expect(submittedSizes).toEqual([2, 1]);

    const first = await durable.processBatchResult(
      {
        eventId: "event-1",
        source: "openai",
        externalId: "provider-1",
        outcome: { status: "complete" },
        payload: { providerStatus: "completed" },
      },
      { store, noSendLogs: true },
    );
    expect(first).toMatchObject({
      status: "processed",
      batchId: expect.any(String),
      run: { status: "paused", reason: "waiting_for_webhook" },
    });

    const second = await durable.processBatchResult(
      {
        eventId: "event-2",
        source: "openai",
        externalId: "provider-2",
        outcome: { status: "complete" },
      },
      { store, noSendLogs: true },
    );
    expect(second).toMatchObject({
      status: "processed",
      run: {
        status: "completed",
        progress: { taskSucceeded: 3, scoreSucceeded: 3 },
      },
    });

    await expect(
      durable.processBatchResult(
        {
          eventId: "event-2",
          source: "openai",
          externalId: "provider-2",
          outcome: { status: "complete" },
        },
        { store, noSendLogs: true },
      ),
    ).resolves.toMatchObject({ status: "duplicate" });

    const storedEvents: string[] = [];
    for await (const key of store.list("durable-eval/v1/webhooks/events/")) {
      const record = await store.read(key);
      if (record) storedEvents.push(new TextDecoder().decode(record.value));
    }
    expect(storedEvents).toHaveLength(2);
    expect(storedEvents.join("\n")).toContain("providerStatus");
  });

  test("stores an early webhook until the provider handle is indexed", async () => {
    const store = new MemoryDurableEvalStore();
    let processEarly:
      | (() => Promise<{ status: string; reason?: string }>)
      | undefined;
    let earlyResult: { status: string; reason?: string } | undefined;
    const task = BatchTask<
      string,
      string,
      string,
      void,
      Record<string, never>,
      { id: string }
    >({
      revision: "task-v1",
      async submit() {
        earlyResult = await processEarly!();
        return { id: "provider-early" };
      },
      completion: {
        mode: "webhook",
        source: "openai",
        externalId: (handle) => handle.id,
      },
      async *collect() {
        yield { id: "one:trial:0", output: "done" };
      },
    });
    const durable = DurableEval("early-webhook", {
      revision: "eval-v1",
      data: [{ id: "one", input: "input", expected: "done" }],
      task,
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
      ],
    });
    processEarly = () =>
      durable.processBatchResult(
        {
          eventId: "early-event",
          source: "openai",
          externalId: "provider-early",
          outcome: { status: "complete" },
        },
        { store, noSendLogs: true },
      );

    const result = await durable.run({
      runId: "early-run",
      store,
      noSendLogs: true,
    });
    expect(earlyResult).toMatchObject({
      status: "pending",
      reason: "unmatched",
    });
    expect(result.status).toBe("completed");
  });

  test("uses a webhook handle to resolve an ambiguous submission", async () => {
    const store = new MemoryDurableEvalStore();
    let batchId: string | undefined;
    const task = BatchTask<
      string,
      string,
      string,
      void,
      Record<string, never>,
      { id: string }
    >({
      revision: "task-v1",
      async submit(_items, context) {
        batchId = context.batchId;
        throw new Error("connection closed after provider accepted the batch");
      },
      completion: {
        mode: "webhook",
        source: "openai",
        externalId: (handle) => handle.id,
      },
      async *collect() {
        yield { id: "one:trial:0", output: "done" };
      },
    });
    const durable = DurableEval("lost-submit-webhook", {
      revision: "eval-v1",
      data: [{ id: "one", input: "input", expected: "done" }],
      task,
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
      ],
    });
    const paused = await durable.run({
      runId: "lost-submit-run",
      store,
      noSendLogs: true,
    });
    expect(paused).toMatchObject({
      status: "paused",
      reason: "unknown_submission",
    });

    const processed = await durable.processBatchResult(
      {
        eventId: "lost-submit-event",
        source: "openai",
        batchId,
        externalId: "provider-lost",
        handle: { id: "provider-lost" },
        outcome: { status: "complete" },
      },
      { store, noSendLogs: true },
    );
    expect(processed).toMatchObject({
      status: "processed",
      run: { status: "completed" },
    });
  });

  test("retries result collection when the provider redelivers a webhook", async () => {
    const store = new MemoryDurableEvalStore();
    let collectAttempts = 0;
    const task = BatchTask<
      string,
      string,
      string,
      void,
      Record<string, never>,
      { id: string }
    >({
      revision: "task-v1",
      async submit() {
        return { id: "provider-retry" };
      },
      completion: {
        mode: "webhook",
        source: "openai",
        externalId: (handle) => handle.id,
      },
      async *collect() {
        collectAttempts++;
        if (collectAttempts === 1) {
          throw new Error("provider result file is temporarily unavailable");
        }
        yield { id: "one:trial:0", output: "done" };
      },
    });
    const durable = DurableEval("collect-retry", {
      revision: "eval-v1",
      data: [{ id: "one", input: "input", expected: "done" }],
      task,
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
      ],
    });
    await durable.run({
      runId: "collect-retry-run",
      store,
      noSendLogs: true,
    });
    const event = {
      eventId: "retry-event",
      source: "openai",
      externalId: "provider-retry",
      outcome: { status: "complete" as const },
    };

    const unavailable = await durable.processBatchResult(event, {
      store,
      noSendLogs: true,
    });
    expect(unavailable).toMatchObject({
      status: "processed",
      run: { status: "paused", reason: "provider_unreachable" },
    });

    const completed = await durable.processBatchResult(event, {
      store,
      noSendLogs: true,
    });
    expect(completed).toMatchObject({
      status: "processed",
      run: { status: "completed" },
    });
    expect(collectAttempts).toBe(2);
  });

  test("does not recover or duplicate a batch while another worker submits it", async () => {
    const store = new MemoryDurableEvalStore();
    let submitCount = 0;
    let releaseSubmit: () => void = () => undefined;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const task = BatchTask<
      string,
      string,
      string,
      void,
      Record<string, never>,
      { jobId: string }
    >({
      revision: "task-v1",
      async submit(_items, context) {
        submitCount++;
        await submitGate;
        return { jobId: context.batchId };
      },
      completion: {
        mode: "poll",
        async poll() {
          return { status: "complete" };
        },
      },
      async *collect() {
        yield { id: "one:trial:0", output: "done" };
      },
    });
    const definition = {
      revision: "eval-v1",
      data: [{ id: "one", input: "input", expected: "done" }],
      task,
      scores: [
        function exact({
          output,
          expected,
        }: {
          output: string;
          expected?: string;
        }) {
          return output === expected ? 1 : 0;
        },
      ],
    };

    const durable = DurableEval("distributed-submit", definition);
    const first = durable.run({
      runId: "distributed-run",
      store,
      noSendLogs: true,
      workerId: "worker-one",
    });
    await vi.waitFor(() => expect(submitCount).toBe(1));

    const second = await durable.run({
      runId: "distributed-run",
      store,
      noSendLogs: true,
      workerId: "worker-two",
      deadlineMs: 10,
    });
    expect(second.status).toBe("paused");
    expect(submitCount).toBe(1);

    releaseSubmit();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    expect(submitCount).toBe(1);
  });

  test("renews provider leases while polling exceeds the lease duration", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryDurableEvalStore();
      let pollCalls = 0;
      let releasePoll: () => void = () => undefined;
      const pollGate = new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      const durable = DurableEval("long-provider-poll", {
        revision: "eval-v1",
        data: [{ id: "one", input: "input" }],
        task: BatchTask<
          string,
          string,
          void,
          void,
          Record<string, never>,
          { id: string }
        >({
          revision: "task-v1",
          async submit() {
            return { id: "long-job" };
          },
          completion: {
            mode: "poll",
            async poll() {
              pollCalls++;
              await pollGate;
              return { status: "complete" };
            },
          },
          async *collect() {
            yield { id: "one:trial:0", output: "done" };
          },
        }),
        scores: [],
      });

      const first = durable.run({
        runId: "long-poll-run",
        store,
        noSendLogs: true,
        workerId: "worker-one",
      });
      while (pollCalls === 0) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(61_000);

      const second = durable.run({
        runId: "long-poll-run",
        store,
        noSendLogs: true,
        workerId: "worker-two",
        deadlineMs: 5,
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(second).resolves.toMatchObject({
        status: "paused",
        reason: "deadline",
      });
      expect(pollCalls).toBe(1);

      releasePoll();
      await vi.advanceTimersByTimeAsync(0);
      await expect(first).resolves.toMatchObject({ status: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancels active provider batches and terminally checkpoints the work", async () => {
    const store = new MemoryDurableEvalStore();
    const abort = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const task = BatchTask<
      string,
      string,
      string,
      void,
      Record<string, never>,
      { jobId: string }
    >({
      revision: "task-v1",
      async submit(_items, context) {
        return { jobId: context.batchId };
      },
      completion: {
        mode: "poll",
        async poll() {
          abort.abort();
          return { status: "pending" };
        },
      },
      async *collect() {
        // A cancelled batch is never collected.
      },
      cancel,
    });
    const definition = {
      revision: "eval-v1",
      data: [{ id: "one", input: "input", expected: "done" }],
      task,
      scores: [
        function exact({
          output,
          expected,
        }: {
          output: string;
          expected?: string;
        }) {
          return output === expected ? 1 : 0;
        },
      ],
    };

    const durable = DurableEval("cancel-batch", definition);
    const paused = await durable.run({
      runId: "cancel-run",
      store,
      noSendLogs: true,
      signal: abort.signal,
    });
    expect(paused).toMatchObject({ status: "paused", reason: "aborted" });

    const cancelled = await durable.cancel({
      runId: "cancel-run",
      store,
      noSendLogs: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancelled).toMatchObject({
      status: "completed",
      failures: { tasks: 1, scorers: 0 },
    });
  });

  test("returns a resumable deadline result without resubmitting a batch", async () => {
    const store = new MemoryDurableEvalStore();
    let ready = false;
    let submits = 0;
    const task = BatchTask<
      string,
      string,
      string,
      void,
      Record<string, never>,
      { jobId: string }
    >({
      revision: "task-v1",
      async submit(_items, context) {
        submits++;
        return { jobId: context.batchId };
      },
      completion: {
        mode: "poll",
        intervalMs: 1,
        async poll() {
          return ready
            ? { status: "complete" as const }
            : { status: "pending" as const, retryAfterMs: 1 };
        },
      },
      async *collect() {
        yield { id: "one:trial:0", output: "done" };
      },
    });

    const definition = {
      revision: "eval-v1",
      data: [{ id: "one", input: "input", expected: "done" }],
      task,
      scores: [
        function exact({
          output,
          expected,
        }: {
          output: string;
          expected?: string;
        }) {
          return output === expected ? 1 : 0;
        },
      ],
    };
    const durable = DurableEval("deadline", definition);
    const first = await durable.run({
      runId: "deadline-run",
      store,
      noSendLogs: true,
      deadlineMs: 5,
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("run did not pause");
    expect(first.reason).toBe("deadline");

    ready = true;
    const second = await first.resume({ deadlineMs: 1_000 });
    expect(second.status).toBe("completed");
    expect(submits).toBe(1);
  });

  test("deadline aborts an active provider submission", async () => {
    const neverSubmitted = new Promise<{ id: string }>(() => undefined);
    const durable = DurableEval("submit-deadline", {
      revision: "eval-v1",
      data: [{ id: "one", input: "input" }],
      task: BatchTask<
        string,
        string,
        void,
        void,
        Record<string, never>,
        { id: string }
      >({
        revision: "task-v1",
        async submit() {
          return await neverSubmitted;
        },
        completion: {
          mode: "poll",
          async poll() {
            return { status: "pending" };
          },
        },
        async *collect() {
          // The submission never returns a handle.
        },
      }),
      scores: [],
    });

    const started = Date.now();
    const result = await durable.run({
      runId: "submit-deadline-run",
      store: new MemoryDurableEvalStore(),
      noSendLogs: true,
      deadlineMs: 10,
    });
    expect(result).toMatchObject({ status: "paused", reason: "deadline" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("reserves one deterministic experiment name across concurrent shards", async () => {
    const store = new MemoryDurableEvalStore();
    const durable = DurableEval("experiment-reservation", {
      revision: "v1",
      data: [
        { id: "one", input: 1 },
        { id: "two", input: 2 },
        { id: "three", input: 3 },
        { id: "four", input: 4 },
      ],
      task: (input) => input,
      scores: [],
    });

    await Promise.all([
      durable.run({
        runId: "shared-run",
        shard: { index: 0, count: 2 },
        store,
        noSendLogs: true,
      }),
      durable.run({
        runId: "shared-run",
        shard: { index: 1, count: 2 },
        store,
        noSendLogs: true,
      }),
    ]);

    const manifests: string[] = [];
    for await (const key of store.list("durable-eval/v1/")) {
      if (!key.endsWith("/manifest")) continue;
      const record = await store.read(key);
      if (record) manifests.push(new TextDecoder().decode(record.value));
    }
    expect(manifests).toHaveLength(1);
    expect(JSON.parse(manifests[0])).toMatchObject({
      experimentName: "experiment-reservation-shared-run",
      shardCount: 2,
    });

    await expect(
      durable.status({
        runId: "shared-run",
        store,
        noSendLogs: true,
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  test("applies lifecycle retries to every shard when no shard is specified", async () => {
    const store = new MemoryDurableEvalStore();
    let succeed = false;
    const durable = DurableEval("sharded-lifecycle", {
      revision: "v1",
      data: [1, 2, 3, 4].map((input) => ({
        id: `case-${input}`,
        input,
      })),
      task: (input) => {
        if (!succeed) throw new Error("try again later");
        return input;
      },
      scores: [],
    });

    await Promise.all([
      durable.run({
        runId: "sharded-lifecycle-run",
        shard: { index: 0, count: 2 },
        store,
        noSendLogs: true,
      }),
      durable.run({
        runId: "sharded-lifecycle-run",
        shard: { index: 1, count: 2 },
        store,
        noSendLogs: true,
      }),
    ]);

    succeed = true;
    await expect(
      durable.retryFailed({
        runId: "sharded-lifecycle-run",
        store,
        noSendLogs: true,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      progress: { taskSucceeded: 4, taskFailed: 0 },
    });
  });

  test("keeps completed work when the definition revision changes", async () => {
    const store = new MemoryDurableEvalStore();
    const firstTask = vi.fn((input: number) => input);
    await DurableEval("revisions", {
      revision: "v1",
      data: [{ id: "one", input: 1, expected: 1 }],
      task: firstTask,
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
      ],
    }).run({
      runId: "revision-run",
      store,
      noSendLogs: true,
    });

    const changedTask = vi.fn(() => 0);
    const result = await DurableEval("revisions", {
      revision: "v2",
      data: [{ id: "one", input: 1, expected: 1 }],
      task: changedTask,
      scores: [
        function exact({ output, expected }) {
          return output === expected ? 1 : 0;
        },
      ],
    }).run({
      runId: "revision-run",
      store,
      noSendLogs: true,
    });

    expect(result.status).toBe("completed");
    expect(firstTask).toHaveBeenCalledOnce();
    expect(changedTask).not.toHaveBeenCalled();
  });

  test("removes inactive scorer state when a definition changes", async () => {
    const store = new MemoryDurableEvalStore();
    await DurableEval("remove-scorer", {
      revision: "v1",
      data: [{ id: "one", input: 1 }],
      task: (input) => input,
      scores: [
        function oldScore() {
          return 1;
        },
      ],
    }).run({
      runId: "remove-scorer-run",
      store,
      noSendLogs: true,
    });

    const result = await DurableEval("remove-scorer", {
      revision: "v2",
      data: [{ id: "one", input: 1 }],
      task: (input) => input,
      scores: [],
    }).run({
      runId: "remove-scorer-run",
      store,
      noSendLogs: true,
    });
    expect(result).toMatchObject({
      status: "completed",
      summary: { scores: {} },
    });

    const cases: Array<Record<string, unknown>> = [];
    for await (const key of store.list("durable-eval/v1/")) {
      if (!key.includes("/cases/")) continue;
      const record = await store.read(key);
      if (record)
        cases.push(JSON.parse(new TextDecoder().decode(record.value)));
    }
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      scores: {},
      removedScores: ["oldScore"],
    });
  });

  test("pauses safely when submit may have created a provider job", async () => {
    const store = new MemoryDurableEvalStore();
    let submitShouldFail = true;
    const definition = {
      revision: "v1",
      data: [{ id: "one", input: "hello", expected: "hello" }],
      task: BatchTask<
        string,
        string,
        string,
        void,
        Record<string, never>,
        { jobId: string }
      >({
        revision: "task-v1",
        async submit(_items, context) {
          if (submitShouldFail) {
            throw new Error("connection closed after request");
          }
          return { jobId: context.batchId };
        },
        completion: {
          mode: "poll",
          async poll() {
            return { status: "complete" };
          },
        },
        async *collect() {
          yield { id: "one:trial:0", output: "hello" };
        },
      }),
      scores: [
        function exact({
          output,
          expected,
        }: {
          output: string;
          expected?: string;
        }) {
          return output === expected ? 1 : 0;
        },
      ],
    };
    const durable = DurableEval("ambiguous-submit", definition);
    const result = await durable.run({
      runId: "ambiguous-run",
      store,
      noSendLogs: true,
    });

    expect(result.status).toBe("paused");
    if (result.status !== "paused") throw new Error("run did not pause");
    expect(result.reason).toBe("unknown_submission");
    expect(result.progress.unknown).toBe(1);

    const status = await durable.status({
      runId: "ambiguous-run",
      store,
      noSendLogs: true,
    });
    expect(status).toMatchObject({
      status: "paused",
      reason: "status_only",
    });

    submitShouldFail = false;
    const resumed = await durable.resubmitUnknown({
      runId: "ambiguous-run",
      store,
      noSendLogs: true,
    });
    expect(resumed.status).toBe("completed");
  });

  test("registers definitions instead of executing during CLI lazy loading", async () => {
    const previousEvals = globalThis._evals;
    const previousLazy = globalThis._lazy_load;
    globalThis._evals = {
      functions: [],
      prompts: [],
      parameters: [],
      evaluators: {},
      durableEvaluators: {},
      reporters: {},
    } satisfies EvaluatorFile;
    globalThis._lazy_load = true;
    const task = vi.fn((input: string) => input);
    try {
      const definition = DurableEval("lazy-project", {
        revision: "v1",
        experimentName: "lazy-eval",
        data: [{ id: "one", input: "hello", expected: "hello" }],
        task,
        scores: [
          function exact({ output, expected }) {
            return output === expected ? 1 : 0;
          },
        ],
      });
      expect(globalThis._evals.durableEvaluators?.["lazy-eval"]).toBeDefined();
      expect(
        globalThis._evals.durableEvaluators?.["lazy-eval"]?.definition,
      ).toBe(definition);
      expect(task).not.toHaveBeenCalled();
    } finally {
      globalThis._evals = previousEvals;
      globalThis._lazy_load = previousLazy;
    }
  });
});
