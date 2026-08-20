import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  bindAnthropicBatchTrace,
  completeAnthropicBatchTrace,
  failAnthropicBatchTrace,
  startAnthropicBatchTrace,
} from "../../anthropic-batch";
import type {
  AnthropicBatchCreateParams,
  AnthropicBatchLike,
  AnthropicBatchResultRecord,
} from "../../anthropic-batch-types";
import {
  _exportsForTestingOnly,
  _internalGetGlobalState,
  BraintrustState,
  initLogger,
  startSpan,
  TestBackgroundLogger,
  withCurrent,
} from "../../logger";
import { configureNode } from "../../node/config";
import { mergeRowBatch } from "../../../util";
import { SpanComponentsV4 } from "../../../util/span_identifier_v4";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

const batchParams: AnthropicBatchCreateParams = {
  requests: [
    {
      custom_id: "ok",
      params: {
        max_tokens: 24,
        messages: [{ role: "user", content: "say hi" }],
        model: "claude-input",
        system: "Be concise",
      },
    },
    {
      custom_id: "bad",
      params: {
        max_tokens: 24,
        messages: [{ role: "user", content: "fail" }],
        model: "claude-input",
      },
    },
  ],
};

type TestRow = { id: string; [key: string]: any };

function terminalBatch(
  overrides: Partial<AnthropicBatchLike> = {},
): AnthropicBatchLike {
  return {
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: new Date(Date.now() + 60_000).toISOString(),
    id: "msgbatch_test",
    processing_status: "ended",
    request_counts: {
      canceled: 0,
      errored: 1,
      expired: 0,
      processing: 0,
      succeeded: 1,
    },
    ...overrides,
  };
}

const batchResults: AnthropicBatchResultRecord[] = [
  {
    custom_id: "bad",
    result: {
      error: {
        error: { message: "batch request failed", type: "api_error" },
        type: "error",
      },
      type: "errored",
    },
  },
  {
    custom_id: "ok",
    result: {
      message: {
        content: [{ text: "hi", type: "text" }],
        id: "msg_test",
        model: "claude-resolved",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: {
          cache_read_input_tokens: 1,
          input_tokens: 2,
          output_tokens: 3,
        },
      },
      type: "succeeded",
    },
  },
];

describe("Anthropic Batch instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    _internalGetGlobalState()._internalSetTraceContextSigningSecret(
      "anthropic-batch-test-secret",
    );
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectId: "test-project-id",
      projectName: "anthropic-batch-instrumentation.test.ts",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("returns provider-ready params and starts pending task and child spans", async () => {
    const source = {
      ...structuredClone(batchParams),
      optional_provider_field: undefined,
    };
    const original = structuredClone(source);
    const started = await startAnthropicBatchTrace({ params: source });

    expect(started.params).toEqual(source);
    expect(source).toEqual(original);
    expect(started.traceContext).toEqual(expect.any(String));
    expect(started.traceContext).not.toContain("say hi");
    expect(started.traceContext).not.toContain("claude-input");

    const rows = (await backgroundLogger.drain()) as TestRow[];
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    expect(rows).toHaveLength(3);
    expect(task).toMatchObject({
      metadata: { provider: "anthropic" },
      span_attributes: { type: "task" },
    });
    expect(task?.input).toBeUndefined();
    expect(task?.metrics).not.toHaveProperty("end");
    expect(children).toHaveLength(2);
    expect(children[0]?.metrics).not.toHaveProperty("end");
    expect(
      children.find((row) => row.input?.[1]?.content === "say hi"),
    ).toMatchObject({
      input: [
        { content: "Be concise", role: "system" },
        { content: "say hi", role: "user" },
      ],
      metadata: { model: "claude-input", provider: "anthropic" },
    });
  });

  it("preserves empty routing args for the default Global project", async () => {
    initLogger();

    const started = await startAnthropicBatchTrace({ params: batchParams });

    expect(started.traceContext).toEqual(expect.any(String));
    if (!started.traceContext) {
      throw new Error("Expected Anthropic Batch trace context");
    }
    const serializedContext = JSON.parse(started.traceContext);
    const parent = SpanComponentsV4.fromStr(serializedContext.parent).data;
    expect(parent.compute_object_metadata_args).toEqual({});
  });

  it("uses one digest per span identity plus one batch input digest", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    try {
      await startAnthropicBatchTrace({ params: batchParams });
      expect(digest).toHaveBeenCalledTimes(batchParams.requests.length + 2);
    } finally {
      digest.mockRestore();
    }
  });

  it("flushes between large start and completion chunks", async () => {
    const params: AnthropicBatchCreateParams = {
      requests: Array.from({ length: 1001 }, (_, index) => ({
        custom_id: `request_${index}`,
        params: {
          max_tokens: 1,
          messages: [{ content: "test", role: "user" }],
          model: "claude-input",
        },
      })),
    };
    const flush = vi.spyOn(backgroundLogger, "flush");
    try {
      const started = await startAnthropicBatchTrace({ params });
      expect(flush).toHaveBeenCalled();
      await backgroundLogger.drain();
      flush.mockClear();

      const batch = terminalBatch({
        id: "msgbatch_chunked",
        request_counts: {
          canceled: 0,
          errored: 0,
          expired: 0,
          processing: 0,
          succeeded: params.requests.length,
        },
      });
      const traceContext = await bindAnthropicBatchTrace({
        batch,
        traceContext: started.traceContext,
      });
      const message = {
        content: [{ text: "ok", type: "text" }],
        id: "msg_chunked",
        model: "claude-resolved",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
      } as const;

      await completeAnthropicBatchTrace({
        batch,
        params: started.params,
        results: params.requests.map((request) => ({
          custom_id: request.custom_id,
          result: { message, type: "succeeded" as const },
        })),
        traceContext,
      });

      expect(flush).toHaveBeenCalled();
    } finally {
      flush.mockRestore();
    }
  });

  it("completes out-of-order success and error results idempotently", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const pendingIds = pending.map((row) => row.id).sort();
    const batch = terminalBatch();
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });

    await expect(
      completeAnthropicBatchTrace({
        batch,
        params: started.params,
        results: Promise.resolve(batchResults),
        traceContext,
      }),
    ).resolves.toBe(batch);

    const completionWrites = (await backgroundLogger.drain()) as TestRow[];
    expect(completionWrites.map((row) => row.id).sort()).toEqual(pendingIds);
    const rows = mergeRowBatch([...pending, ...completionWrites]);
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    expect(task?.metrics?.end).toEqual(expect.any(Number));
    expect(children.find((row) => row.output)).toMatchObject({
      metadata: {
        model: "claude-resolved",
        provider: "anthropic",
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      metrics: {
        completion_tokens: 3,
        prompt_cached_tokens: 1,
        prompt_tokens: 3,
        tokens: 6,
      },
      output: {
        content: [{ text: "hi", type: "text" }],
        role: "assistant",
      },
    });
    expect(children.find((row) => row.error)?.error).toContain(
      "batch request failed",
    );
    expect(
      children.every((row) => row.metrics?.time_to_first_token === undefined),
    ).toBe(true);

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: batchResults,
      traceContext,
    });
    const replay = (await backgroundLogger.drain()) as TestRow[];
    expect(replay.map((row) => row.id).sort()).toEqual(pendingIds);
  });

  it("uses collect-only tracing for an unbound start context", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];

    await completeAnthropicBatchTrace({
      batch: terminalBatch({ id: "msgbatch_bound_during_completion" }),
      params: started.params,
      results: batchResults,
      traceContext: started.traceContext,
    });

    const completionRows = (await backgroundLogger.drain()) as TestRow[];
    expect(completionRows).toHaveLength(3);
    expect(
      completionRows.filter((row) =>
        pending.some((pendingRow) => pendingRow.id === row.id),
      ),
    ).toEqual([]);
    expect(
      completionRows.every((row) => typeof row.metrics?.end === "number"),
    ).toBe(true);
  });

  it("binds a start context explicitly before resuming it", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch({ id: "msgbatch_explicitly_bound" });
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: batchResults,
      traceContext,
    });

    const writes = (await backgroundLogger.drain()) as TestRow[];
    expect(writes.map((row) => row.id).sort()).toEqual(
      pending.map((row) => row.id).sort(),
    );
    expect(
      mergeRowBatch([...pending, ...writes]).every(
        (row) => typeof row.metrics?.end === "number",
      ),
    ).toBe(true);
  });

  it("leaves nonterminal and incomplete batches pending", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch();
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    let reads = 0;
    async function* results() {
      reads++;
      yield batchResults[0];
    }

    await completeAnthropicBatchTrace({
      batch: { ...batch, processing_status: "in_progress" },
      params: started.params,
      results: results(),
      traceContext,
    });
    expect(reads).toBe(0);
    expect(await backgroundLogger.drain()).toEqual([]);

    let thenCalls = 0;
    const lazyResults: PromiseLike<typeof batchResults> = {
      then(onfulfilled, onrejected) {
        thenCalls++;
        return Promise.resolve(batchResults).then(onfulfilled, onrejected);
      },
    };
    await completeAnthropicBatchTrace({
      batch: { ...batch, processing_status: "in_progress" },
      params: started.params,
      results: lazyResults,
      traceContext,
    });
    expect(thenCalls).toBe(0);

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: [batchResults[0]],
      traceContext,
    });
    const writes = (await backgroundLogger.drain()) as TestRow[];
    const rows = mergeRowBatch([...pending, ...writes]);
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    expect(task?.metrics).not.toHaveProperty("end");
  });

  it("falls back to collect-only tracing without start context", async () => {
    const batch = terminalBatch({ id: "msgbatch_collect_only" });
    await completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: batchResults,
    });
    const first = (await backgroundLogger.drain()) as TestRow[];
    expect(first).toHaveLength(3);
    expect(
      first.find((row) => row.span_attributes?.name === "anthropic.batch")
        ?.metrics?.end,
    ).toEqual(expect.any(Number));

    await completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: batchResults,
      traceContext: "invalid",
    });
    const replay = (await backgroundLogger.drain()) as TestRow[];
    expect(replay.map((row) => row.id).sort()).toEqual(
      first.map((row) => row.id).sort(),
    );
  });

  it("does not publish collect-only children before consuming results", async () => {
    const batch = terminalBatch({ id: "msgbatch_atomic_collect_only" });
    let enteredResults!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResults = resolve;
    });
    let releaseResults!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseResults = resolve;
    });
    async function* delayedResults() {
      enteredResults();
      await released;
      yield* batchResults;
    }

    const completion = completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: delayedResults(),
    });
    await entered;
    const beforeResults = (await backgroundLogger.drain()) as TestRow[];
    expect(beforeResults).toHaveLength(1);
    expect(beforeResults[0]?.span_attributes?.name).toBe("anthropic.batch");

    releaseResults();
    await completion;
    const completed = (await backgroundLogger.drain()) as TestRow[];
    const children = completed.filter(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    expect(children).toHaveLength(2);
    expect(
      children.every(
        (row) =>
          row.input !== undefined &&
          typeof row.metrics?.start === "number" &&
          typeof row.metrics?.end === "number",
      ),
    ).toBe(true);
    expect(children.find((row) => row.output)?.metadata?.model).toBe(
      "claude-resolved",
    );
  });

  it("routes every batch operation through a custom state", async () => {
    const state = new BraintrustState({});
    const stateLogger = new TestBackgroundLogger();
    state.setOverrideBgLogger(stateLogger);
    state.orgId = "custom-state-org";
    vi.spyOn(state, "login").mockResolvedValue(undefined);
    initLogger({
      projectId: "00000000-0000-4000-8000-000000000001",
      projectName: "custom-state-project",
      state,
    });
    state._internalSetTraceContextSigningSecret("custom-state-secret");

    const started = await startAnthropicBatchTrace({
      params: batchParams,
      state,
    });
    const pending = (await stateLogger.drain()) as TestRow[];
    expect(pending).toHaveLength(3);
    expect(await backgroundLogger.drain()).toEqual([]);

    const batch = terminalBatch({ id: "msgbatch_custom_state" });
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      state,
      traceContext: started.traceContext,
    });
    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: batchResults,
      state,
      traceContext,
    });

    const completed = (await stateLogger.drain()) as TestRow[];
    expect(completed.map((row) => row.id).sort()).toEqual(
      pending.map((row) => row.id).sort(),
    );
    expect(await backgroundLogger.drain()).toEqual([]);

    const failed = await startAnthropicBatchTrace({
      params: batchParams,
      state,
    });
    const failedPending = (await stateLogger.drain()) as TestRow[];
    await failAnthropicBatchTrace({
      error: new Error("submission failed"),
      params: failed.params,
      state,
      traceContext: failed.traceContext!,
    });
    const failureWrites = (await stateLogger.drain()) as TestRow[];
    expect(failureWrites.map((row) => row.id).sort()).toEqual(
      failedPending.map((row) => row.id).sort(),
    );
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("keeps collect-only span identities scoped to the active parent", async () => {
    const batch = terminalBatch({ id: "msgbatch_parent_scoped" });
    const firstParent = startSpan({ name: "first-parent" });
    await withCurrent(firstParent, () =>
      completeAnthropicBatchTrace({
        batch,
        params: batchParams,
        results: batchResults,
      }),
    );
    firstParent.end();
    const firstRows = ((await backgroundLogger.drain()) as TestRow[]).filter(
      (row) => row.span_attributes?.name?.startsWith("anthropic."),
    );

    const secondParent = startSpan({ name: "second-parent" });
    await withCurrent(secondParent, () =>
      completeAnthropicBatchTrace({
        batch,
        params: batchParams,
        results: batchResults,
      }),
    );
    secondParent.end();
    const secondRows = ((await backgroundLogger.drain()) as TestRow[]).filter(
      (row) => row.span_attributes?.name?.startsWith("anthropic."),
    );

    expect(firstRows).toHaveLength(3);
    expect(secondRows).toHaveLength(3);
    expect(
      secondRows.filter((row) =>
        firstRows.some((firstRow) => firstRow.id === row.id),
      ),
    ).toEqual([]);
  });

  it("propagates provider result promise and iteration failures", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch();
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    const downloadError = new Error("results download failed");
    const failedDownload = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(downloadError), 0);
    });

    await expect(
      completeAnthropicBatchTrace({
        batch,
        params: started.params,
        results: failedDownload,
        traceContext,
      }),
    ).rejects.toBe(downloadError);

    const iterationError = new Error("results stream failed");
    async function* failingResults() {
      yield batchResults[0];
      throw iterationError;
    }
    await expect(
      completeAnthropicBatchTrace({
        batch,
        params: started.params,
        results: failingResults(),
        traceContext,
      }),
    ).rejects.toBe(iterationError);

    const partialWrites = (await backgroundLogger.drain()) as TestRow[];
    const terminalDownloadError = new Error("terminal results download failed");
    const terminalFailure = terminalBatch({
      request_counts: {
        canceled: 1,
        errored: 0,
        expired: 1,
        processing: 0,
        succeeded: 0,
      },
    });
    await expect(
      completeAnthropicBatchTrace({
        batch: terminalFailure,
        params: started.params,
        results: Promise.reject(terminalDownloadError),
        traceContext,
      }),
    ).rejects.toBe(terminalDownloadError);

    const rows = mergeRowBatch([
      ...pending,
      ...partialWrites,
      ...((await backgroundLogger.drain()) as TestRow[]),
    ]);
    expect(
      rows.every(
        (row) =>
          typeof row.metrics?.end === "number" &&
          row.error?.includes("1 canceled and 1 expired"),
      ),
    ).toBe(true);
  });

  it("stops and closes a results iterable after one excess record", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch();
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    let yielded = 0;
    let closed = false;
    async function* excessResults() {
      try {
        while (true) {
          const result = batchResults[yielded++ % batchResults.length];
          if (!result) {
            throw new Error("Expected Anthropic Batch result fixture");
          }
          yield result;
        }
      } finally {
        closed = true;
      }
    }

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: excessResults(),
      traceContext,
    });

    expect(yielded).toBe(batchParams.requests.length + 1);
    expect(closed).toBe(true);
    const rows = mergeRowBatch([
      ...pending,
      ...((await backgroundLogger.drain()) as TestRow[]),
    ]);
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    expect(task?.metrics).not.toHaveProperty("end");
  });

  it("assimilates a lazy results PromiseLike exactly once", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    await backgroundLogger.drain();
    const batch = terminalBatch();
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    let thenCalls = 0;
    const lazyResults: PromiseLike<typeof batchResults> = {
      then(onfulfilled, onrejected) {
        thenCalls++;
        return Promise.resolve(batchResults).then(onfulfilled, onrejected);
      },
    };

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: lazyResults,
      traceContext,
    });

    expect(thenCalls).toBe(1);
  });

  it("requires a context bound to the matching provider batch", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const originalBatch = terminalBatch({ id: "msgbatch_original" });
    const traceContext = await bindAnthropicBatchTrace({
      batch: originalBatch,
      traceContext: started.traceContext,
    });
    const swappedBatch = terminalBatch({ id: "msgbatch_swapped" });

    await completeAnthropicBatchTrace({
      batch: swappedBatch,
      params: started.params,
      results: batchResults,
      traceContext,
    });

    const collectOnlyRows = (await backgroundLogger.drain()) as TestRow[];
    expect(collectOnlyRows).toHaveLength(3);
    expect(
      collectOnlyRows.filter((row) =>
        pending.some((pendingRow) => pendingRow.id === row.id),
      ),
    ).toEqual([]);
    expect(
      collectOnlyRows.every((row) => typeof row.metrics?.end === "number"),
    ).toBe(true);
  });

  it("does not treat an unavailable signing credential as an invalid context", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    await backgroundLogger.drain();
    const batch = terminalBatch();
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    const state = _internalGetGlobalState();
    const resolveSecret = vi
      .spyOn(state, "_internalResolveTraceContextSigningSecret")
      .mockResolvedValue(undefined);
    let reads = 0;
    async function* results() {
      reads++;
      yield* batchResults;
    }

    try {
      await completeAnthropicBatchTrace({
        batch,
        params: started.params,
        results: results(),
        traceContext,
      });
    } finally {
      resolveSecret.mockRestore();
    }

    expect(reads).toBe(0);
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("returns no bound context when signing credentials are unavailable", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    await backgroundLogger.drain();
    const batch = terminalBatch();
    const state = _internalGetGlobalState();
    const resolveSecret = vi
      .spyOn(state, "_internalResolveTraceContextSigningSecret")
      .mockResolvedValue(undefined);

    try {
      await expect(
        bindAnthropicBatchTrace({
          batch,
          traceContext: started.traceContext,
        }),
      ).resolves.toBeUndefined();
    } finally {
      resolveSecret.mockRestore();
    }

    await expect(
      bindAnthropicBatchTrace({
        batch,
        traceContext: started.traceContext,
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it("rejects oversized contexts and batch IDs before credential work", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    await backgroundLogger.drain();
    if (!started.traceContext) {
      throw new Error("Expected Anthropic Batch trace context");
    }
    const state = _internalGetGlobalState();
    const resolveSecret = vi.spyOn(
      state,
      "_internalResolveTraceContextSigningSecret",
    );
    try {
      await expect(
        bindAnthropicBatchTrace({
          batch: terminalBatch(),
          traceContext: "x".repeat(5000),
        }),
      ).resolves.toBeUndefined();
      await expect(
        bindAnthropicBatchTrace({
          batch: terminalBatch({ id: "x".repeat(300) }),
          traceContext: started.traceContext,
        }),
      ).resolves.toBeUndefined();
      const oversizedParent = JSON.parse(started.traceContext);
      oversizedParent.parent = "x".repeat(2500);
      await expect(
        bindAnthropicBatchTrace({
          batch: terminalBatch(),
          traceContext: JSON.stringify(oversizedParent),
        }),
      ).resolves.toBeUndefined();
      expect(resolveSecret).not.toHaveBeenCalled();
    } finally {
      resolveSecret.mockRestore();
    }
  });

  it("clears prior child outcomes when a retry corrects mismatched result counts", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch();
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    const message = {
      content: [{ text: "retry result", type: "text" }],
      id: "msg_retry",
      model: "claude-retry",
      role: "assistant",
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      usage: {
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 3,
        input_tokens: 2,
        output_tokens: 1,
      },
    } as const;
    const error = {
      error: { message: "retry error", type: "api_error" },
      type: "error",
    } as const;

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: [
        { custom_id: "ok", result: { message, type: "succeeded" } },
        { custom_id: "bad", result: { message, type: "succeeded" } },
      ],
      traceContext,
    });
    const firstWrites = (await backgroundLogger.drain()) as TestRow[];
    const taskId = pending.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    )?.id;
    expect(
      firstWrites.some(
        (row) => row.id === taskId && row.metrics?.end !== undefined,
      ),
    ).toBe(false);

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: [
        { custom_id: "ok", result: { error, type: "errored" } },
        { custom_id: "bad", result: { error, type: "errored" } },
      ],
      traceContext,
    });
    const secondWrites = (await backgroundLogger.drain()) as TestRow[];
    expect(
      secondWrites.some(
        (row) => row.id === taskId && row.metrics?.end !== undefined,
      ),
    ).toBe(false);

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: batchResults,
      traceContext,
    });
    const finalWrites = (await backgroundLogger.drain()) as TestRow[];
    const rows = mergeRowBatch([
      ...pending,
      ...firstWrites,
      ...secondWrites,
      ...finalWrites,
    ]);
    const task = rows.find((row) => row.id === taskId);
    const children = rows.filter(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    const succeeded = children.find((row) => row.output);
    const errored = children.find((row) => row.error);
    expect(task?.metrics?.end).toEqual(expect.any(Number));
    expect(succeeded).toMatchObject({
      error: null,
      metadata: { model: "claude-resolved" },
      metrics: {
        completion_tokens: 3,
        prompt_cached_tokens: 1,
        prompt_tokens: 3,
        tokens: 6,
      },
      output: {
        content: [{ text: "hi", type: "text" }],
        role: "assistant",
      },
    });
    expect(errored).toMatchObject({
      metadata: {
        model: "claude-input",
      },
      metrics: {
        start: expect.any(Number),
      },
      output: null,
    });
    expect(errored?.metrics).not.toHaveProperty("completion_tokens");
    expect(errored?.metrics).not.toHaveProperty("prompt_cache_creation_tokens");
    expect(errored?.metrics).not.toHaveProperty("prompt_cached_tokens");
    expect(errored?.metrics).not.toHaveProperty("prompt_tokens");
    expect(errored?.metrics).not.toHaveProperty("tokens");
    expect(errored?.metadata).not.toHaveProperty("stop_reason");
    expect(errored?.metadata).not.toHaveProperty("stop_sequence");
    expect(errored?.error).toContain("batch request failed");
  });

  it("leaves malformed request counts pending without consuming results", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch({
      request_counts: {
        canceled: 0,
        errored: 1,
        expired: 0,
        processing: 0,
        succeeded: Number.NaN,
      },
    });
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    let thenCalls = 0;
    const results: PromiseLike<typeof batchResults> = {
      then(onfulfilled, onrejected) {
        thenCalls++;
        return Promise.resolve(batchResults).then(onfulfilled, onrejected);
      },
    };

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results,
      traceContext,
    });

    expect(thenCalls).toBe(0);
    expect(await backgroundLogger.drain()).toEqual([]);
    const task = pending.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    expect(task?.metrics).not.toHaveProperty("end");
  });

  it("leaves structurally malformed successful messages and the task pending", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch({ id: "msgbatch_malformed_message" });
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: [
        batchResults[0],
        {
          custom_id: "ok",
          result: {
            message: {
              content: "invalid content",
              id: "msg_invalid_usage",
              model: "claude-resolved",
              role: "assistant",
              stop_reason: "end_turn",
              stop_sequence: null,
              type: "message",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            type: "succeeded",
          },
        },
      ],
      traceContext,
    });

    const writes = (await backgroundLogger.drain()) as TestRow[];
    const rows = mergeRowBatch([...pending, ...writes]);
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    const malformedChild = rows.find(
      (row) => row.input?.[1]?.content === "say hi",
    );
    const erroredChild = rows.find((row) => row.input?.[0]?.content === "fail");
    expect(task?.metrics).not.toHaveProperty("end");
    expect(malformedChild?.metrics).not.toHaveProperty("end");
    expect(erroredChild?.metrics?.end).toEqual(expect.any(Number));
  });

  it("completes successful messages without optional telemetry", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch({ id: "msgbatch_optional_telemetry" });
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: [
        batchResults[0],
        {
          custom_id: "ok",
          result: {
            message: {
              content: [{ text: "telemetry optional", type: "text" }],
              role: "assistant",
              type: "message",
              usage: { input_tokens: Number.NaN, output_tokens: -1 },
            },
            type: "succeeded",
          },
        },
      ],
      traceContext,
    });

    const rows = mergeRowBatch([
      ...pending,
      ...((await backgroundLogger.drain()) as TestRow[]),
    ]);
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    const succeeded = rows.find((row) => row.input?.[1]?.content === "say hi");
    expect(task?.metrics?.end).toEqual(expect.any(Number));
    expect(succeeded).toMatchObject({
      error: null,
      metadata: { model: "claude-input" },
      output: {
        content: [{ text: "telemetry optional", type: "text" }],
        role: "assistant",
      },
    });
    expect(succeeded?.metrics).not.toHaveProperty("prompt_tokens");
    expect(succeeded?.metrics).not.toHaveProperty("completion_tokens");
    expect(succeeded?.metrics).not.toHaveProperty("tokens");
  });

  it("closes unresolved children for terminal cancellation or expiration", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch({
      id: "msgbatch_incomplete_terminal_failure",
      request_counts: {
        canceled: 1,
        errored: 0,
        expired: 1,
        processing: 0,
        succeeded: 0,
      },
    });
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results: [
        { custom_id: "bad", result: { type: "canceled" } },
        {
          custom_id: "ok",
          result: {
            message: {
              content: "malformed",
              role: "assistant",
              type: "message",
            },
            type: "succeeded",
          },
        },
      ],
      traceContext,
    });

    const rows = mergeRowBatch([
      ...pending,
      ...((await backgroundLogger.drain()) as TestRow[]),
    ]);
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    expect(task?.error).toContain("1 canceled and 1 expired");
    expect(task?.metrics?.end).toEqual(expect.any(Number));
    expect(children).toHaveLength(2);
    expect(
      children.every(
        (row) =>
          typeof row.error === "string" && typeof row.metrics?.end === "number",
      ),
    ).toBe(true);
    expect(
      children.find((row) => row.input?.[1]?.content === "say hi")?.error,
    ).toContain("1 canceled and 1 expired");
  });

  it("marks a consistently canceled or expired batch task as failed", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const batch = terminalBatch({
      request_counts: {
        canceled: 1,
        errored: 0,
        expired: 1,
        processing: 0,
        succeeded: 0,
      },
    });
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    const results = [
      { custom_id: "ok", result: { type: "canceled" as const } },
      { custom_id: "bad", result: { type: "expired" as const } },
    ];

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results,
      traceContext,
    });

    const failedWrites = (await backgroundLogger.drain()) as TestRow[];
    const failedRows = mergeRowBatch([
      ...structuredClone(pending),
      ...structuredClone(failedWrites),
    ]);
    const failedTask = failedRows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    expect(failedTask?.error).toContain("1 canceled and 1 expired");
    expect(failedTask?.metrics?.end).toEqual(expect.any(Number));

    const correctedBatch = terminalBatch({
      id: batch.id,
      request_counts: {
        canceled: 0,
        errored: 0,
        expired: 0,
        processing: 0,
        succeeded: 2,
      },
    });
    const succeeded = batchResults[1];
    if (!succeeded) {
      throw new Error("Expected succeeded Anthropic Batch result fixture");
    }
    await completeAnthropicBatchTrace({
      batch: correctedBatch,
      params: started.params,
      results: [succeeded, { ...succeeded, custom_id: "bad" }],
      traceContext,
    });

    const rows = mergeRowBatch([
      ...pending,
      ...failedWrites,
      ...((await backgroundLogger.drain()) as TestRow[]),
    ]);
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    expect(task?.error).toBeNull();
    expect(task?.metrics?.end).toEqual(expect.any(Number));
  });

  it("does not rewrite input attachments when completing or retrying", async () => {
    const params: AnthropicBatchCreateParams = {
      requests: [
        {
          custom_id: "attachment",
          params: {
            max_tokens: 24,
            messages: [
              {
                role: "user",
                content: [
                  {
                    source: {
                      data: btoa("test image"),
                      media_type: "image/png",
                      type: "base64",
                    },
                    type: "image",
                  },
                ],
              },
            ],
            model: "claude-input",
          },
        },
      ],
    };
    const started = await startAnthropicBatchTrace({ params });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const child = pending.find(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    const attachment = child?.input?.[0]?.content?.[0]?.source?.data;
    const attachmentKey = attachment?.reference?.key ?? attachment?.key;
    expect(attachmentKey).toEqual(expect.any(String));
    const batch = terminalBatch({
      id: "msgbatch_attachment",
      request_counts: {
        canceled: 0,
        errored: 0,
        expired: 0,
        processing: 0,
        succeeded: 1,
      },
    });
    const traceContext = await bindAnthropicBatchTrace({
      batch,
      traceContext: started.traceContext,
    });
    const results = [
      {
        custom_id: "attachment",
        result: {
          message: {
            content: [{ text: "ok", type: "text" }],
            id: "msg_attachment",
            model: "claude-resolved",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          type: "succeeded" as const,
        },
      },
    ];

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results,
      traceContext,
    });
    const firstWrites = (await backgroundLogger.drain()) as TestRow[];
    expect(firstWrites.every((row) => row.input === undefined)).toBe(true);

    await completeAnthropicBatchTrace({
      batch,
      params: started.params,
      results,
      traceContext,
    });
    const retryWrites = (await backgroundLogger.drain()) as TestRow[];
    expect(retryWrites.every((row) => row.input === undefined)).toBe(true);
    const merged = mergeRowBatch([...pending, ...firstWrites, ...retryWrites]);
    const mergedChild = merged.find((row) => row.id === child?.id);
    const mergedAttachment =
      mergedChild?.input?.[0]?.content?.[0]?.source?.data;
    expect(mergedAttachment?.reference?.key ?? mergedAttachment?.key).toBe(
      attachmentKey,
    );

    const collectOnlyBatch = {
      ...batch,
      id: "msgbatch_collect_only_attachment",
    };
    await completeAnthropicBatchTrace({
      batch: collectOnlyBatch,
      params,
      results,
    });
    const firstCollect = (await backgroundLogger.drain()) as TestRow[];
    const firstCollectChild = firstCollect.find(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    const firstCollectAttachment =
      firstCollectChild?.input?.[0]?.content?.[0]?.source?.data;
    const firstCollectKey =
      firstCollectAttachment?.reference?.key ?? firstCollectAttachment?.key;
    expect(firstCollectKey).toEqual(expect.any(String));

    await completeAnthropicBatchTrace({
      batch: collectOnlyBatch,
      params,
      results,
    });
    const retryCollect = (await backgroundLogger.drain()) as TestRow[];
    const retryCollectChild = retryCollect.find(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    const retryCollectAttachment =
      retryCollectChild?.input?.[0]?.content?.[0]?.source?.data;
    expect(
      retryCollectAttachment?.reference?.key ?? retryCollectAttachment?.key,
    ).toBe(firstCollectKey);
  });

  it("ends every pending span when submission fails", async () => {
    const started = await startAnthropicBatchTrace({ params: batchParams });
    const pending = (await backgroundLogger.drain()) as TestRow[];
    await failAnthropicBatchTrace({
      error: new Error("submission failed"),
      params: started.params,
      traceContext: started.traceContext!,
    });
    const rows = (await backgroundLogger.drain()) as TestRow[];
    expect(rows.map((row) => row.id).sort()).toEqual(
      pending.map((row) => row.id).sort(),
    );
    expect(rows.every((row) => row.error?.includes("submission failed"))).toBe(
      true,
    );
    expect(rows.every((row) => typeof row.metrics?.end === "number")).toBe(
      true,
    );
  });

  it("closes partially initialized spans and omits resumable context", async () => {
    const hostileContent: Record<string, unknown> = { type: "text" };
    Object.defineProperty(hostileContent, "text", {
      enumerable: true,
      get() {
        throw new Error("input extraction failed");
      },
    });
    const params: AnthropicBatchCreateParams = {
      requests: [
        batchParams.requests[0],
        {
          custom_id: "unextractable",
          params: {
            max_tokens: 24,
            messages: [{ role: "user", content: [hostileContent] }],
            model: "claude-input",
          },
        },
        batchParams.requests[1],
      ],
    };

    const started = await startAnthropicBatchTrace({ params });
    const writes = (await backgroundLogger.drain()) as TestRow[];
    const rows = mergeRowBatch(writes);

    expect(started.traceContext).toBeUndefined();
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row) =>
          typeof row.metrics?.start === "number" &&
          row.context !== undefined &&
          row.span_attributes?.name !== undefined,
      ),
    ).toBe(true);
    expect(rows.every((row) => typeof row.metrics?.end === "number")).toBe(
      true,
    );
    expect(
      rows.every((row) => row.error?.includes("input extraction failed")),
    ).toBe(true);
    expect(
      rows.find((row) => row.input?.[0]?.content === "fail"),
    ).toBeDefined();
  });

  it("does not trace invalid or duplicate input records", async () => {
    const started = await startAnthropicBatchTrace({
      params: {
        requests: [batchParams.requests[0], batchParams.requests[0]],
      },
    });
    expect(started.traceContext).toBeUndefined();
    expect(started.params.requests).toHaveLength(2);
    expect(await backgroundLogger.drain()).toEqual([]);
  });
});
