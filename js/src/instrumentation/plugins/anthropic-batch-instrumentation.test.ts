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
  anthropicBatchesCreateTraced,
  completeAnthropicBatchTrace,
} from "../../anthropic-batch";
import type {
  AnthropicAPIPromise,
  AnthropicBatchCreateParams,
  AnthropicBatchLike,
  AnthropicBatchResultRecord,
  AnthropicEnhancedResponse,
} from "../../anthropic-batch-types";
import {
  _exportsForTestingOnly,
  BraintrustState,
  initLogger,
  startSpan,
  TestBackgroundLogger,
  withCurrent,
} from "../../logger";
import { configureNode } from "../../node/config";
import { mergeRowBatch } from "../../../util";

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

function apiPromise<T>(dataPromise: Promise<T>): AnthropicAPIPromise<T> {
  const promise = dataPromise as AnthropicAPIPromise<T>;
  let enhancedResponse: Promise<AnthropicEnhancedResponse<T>> | undefined;
  promise.withResponse = () => {
    enhancedResponse ??= dataPromise.then((data) => ({
      data,
      request_id: "request-id",
      response: new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      }),
    }));
    return enhancedResponse;
  };
  promise.asResponse = async () => (await promise.withResponse()).response;
  return promise;
}

function tracedCreate(
  batch: AnthropicBatchLike,
  params: AnthropicBatchCreateParams = batchParams,
  traceOptions?: { state?: BraintrustState },
) {
  return anthropicBatchesCreateTraced(
    {
      create(receivedParams: AnthropicBatchCreateParams) {
        expect(receivedParams).toBe(params);
        return apiPromise(Promise.resolve(batch));
      },
    },
    traceOptions,
  )(params);
}

describe("Anthropic Batch instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
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

  it("wraps batches.create and starts pending task and child spans", async () => {
    const params = structuredClone(batchParams);
    const original = structuredClone(params);
    const batch = terminalBatch({ id: "msgbatch_create" });
    const resource = {
      marker: "batches-resource",
      create(
        this: { marker: string },
        receivedParams: AnthropicBatchCreateParams,
        options?: { timeout: number },
      ) {
        expect(this.marker).toBe("batches-resource");
        expect(receivedParams).toBe(params);
        expect(options).toEqual({ timeout: 10 });
        return apiPromise(Promise.resolve(batch));
      },
    };

    const request = anthropicBatchesCreateTraced(resource)(params, {
      timeout: 10,
    });
    expect(typeof request.withResponse).toBe("function");
    expect(typeof request.asResponse).toBe("function");
    await expect(request).resolves.toBe(batch);
    expect(params).toEqual(original);

    const rows = (await backgroundLogger.drain()) as TestRow[];
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "anthropic.messages.create",
    );
    expect(rows).toHaveLength(3);
    expect(task).toMatchObject({
      metadata: { batch_id: batch.id, provider: "anthropic" },
      span_attributes: { type: "task" },
    });
    expect(task?.input).toBeUndefined();
    expect(task?.metrics).not.toHaveProperty("end");
    expect(children).toHaveLength(2);
    expect(children.every((row) => row.metrics?.end === undefined)).toBe(true);
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

  it("preserves withResponse and asResponse consumption", async () => {
    const withResponseBatch = terminalBatch({ id: "msgbatch_with_response" });
    const withResponse = tracedCreate(withResponseBatch);
    await expect(withResponse.withResponse()).resolves.toMatchObject({
      data: withResponseBatch,
      request_id: "request-id",
    });
    expect((await backgroundLogger.drain()) as TestRow[]).toHaveLength(3);

    const asResponseBatch = terminalBatch({ id: "msgbatch_as_response" });
    const asResponse = tracedCreate(asResponseBatch);
    const response = await asResponse.asResponse();
    expect(response).toBeInstanceOf(Response);
    expect((await response.json()).id).toBe(asResponseBatch.id);
    expect((await backgroundLogger.drain()) as TestRow[]).toHaveLength(3);
  });

  it("propagates create failures without creating spans", async () => {
    const createError = new Error("submission failed");
    const create = anthropicBatchesCreateTraced({
      create() {
        return apiPromise(Promise.reject(createError));
      },
    });

    await expect(create(batchParams)).rejects.toBe(createError);
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("completes out-of-order success and error results idempotently", async () => {
    const batch = terminalBatch({ id: "msgbatch_complete" });
    await tracedCreate(batch);
    const pending = (await backgroundLogger.drain()) as TestRow[];
    const pendingIds = pending.map((row) => row.id).sort();

    await expect(
      completeAnthropicBatchTrace({
        batch,
        params: batchParams,
        results: Promise.resolve(batchResults),
      }),
    ).resolves.toBeUndefined();

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

    await completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: batchResults,
    });
    const replay = (await backgroundLogger.drain()) as TestRow[];
    expect(replay.map((row) => row.id).sort()).toEqual(pendingIds);
  });

  it("leaves nonterminal and incomplete batches pending", async () => {
    const batch = terminalBatch({ id: "msgbatch_pending" });
    await tracedCreate(batch);
    const pending = (await backgroundLogger.drain()) as TestRow[];
    let reads = 0;
    async function* results() {
      reads++;
      yield batchResults[0];
    }

    await completeAnthropicBatchTrace({
      batch: { ...batch, processing_status: "in_progress" },
      params: batchParams,
      results: results(),
    });
    expect(reads).toBe(0);
    expect(await backgroundLogger.drain()).toEqual([]);

    await completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: [batchResults[0]],
    });
    const rows = mergeRowBatch([
      ...pending,
      ...((await backgroundLogger.drain()) as TestRow[]),
    ]);
    const task = rows.find(
      (row) => row.span_attributes?.name === "anthropic.batch",
    );
    expect(task?.metrics).not.toHaveProperty("end");
  });

  it("creates a collect-only trace when create was not wrapped", async () => {
    const batch = terminalBatch({ id: "msgbatch_collect_only" });
    await completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: batchResults,
    });

    const rows = (await backgroundLogger.drain()) as TestRow[];
    expect(rows).toHaveLength(3);
    expect(
      rows.find((row) => row.span_attributes?.name === "anthropic.batch"),
    ).toMatchObject({
      metadata: { batch_id: batch.id, provider: "anthropic" },
      metrics: { end: expect.any(Number), start: expect.any(Number) },
    });
    expect(
      rows
        .filter(
          (row) => row.span_attributes?.name === "anthropic.messages.create",
        )
        .every(
          (row) =>
            row.input !== undefined && typeof row.metrics?.end === "number",
        ),
    ).toBe(true);
  });

  it("routes creation and completion through a custom state", async () => {
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
    const batch = terminalBatch({ id: "msgbatch_custom_state" });

    await tracedCreate(batch, batchParams, { state });
    const pending = (await stateLogger.drain()) as TestRow[];
    expect(pending).toHaveLength(3);
    expect(await backgroundLogger.drain()).toEqual([]);

    await completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: batchResults,
    });
    const completed = (await stateLogger.drain()) as TestRow[];
    expect(completed.map((row) => row.id).sort()).toEqual(
      pending.map((row) => row.id).sort(),
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
    const batch = terminalBatch({ id: "msgbatch_result_failure" });
    await tracedCreate(batch);
    await backgroundLogger.drain();
    const downloadError = new Error("results download failed");

    await expect(
      completeAnthropicBatchTrace({
        batch,
        params: batchParams,
        results: Promise.reject(downloadError),
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
        params: batchParams,
        results: failingResults(),
      }),
    ).rejects.toBe(iterationError);
  });

  it("stops and closes a results iterable after one excess record", async () => {
    const batch = terminalBatch({ id: "msgbatch_excess" });
    await tracedCreate(batch);
    const pending = (await backgroundLogger.drain()) as TestRow[];
    let yielded = 0;
    let closed = false;
    async function* excessResults() {
      try {
        while (true) {
          yield batchResults[yielded++ % batchResults.length]!;
        }
      } finally {
        closed = true;
      }
    }

    await completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: excessResults(),
    });

    expect(yielded).toBe(batchParams.requests.length + 1);
    expect(closed).toBe(true);
    const rows = mergeRowBatch([
      ...pending,
      ...((await backgroundLogger.drain()) as TestRow[]),
    ]);
    expect(
      rows.find((row) => row.span_attributes?.name === "anthropic.batch")
        ?.metrics,
    ).not.toHaveProperty("end");
  });

  it("closes canceled and expired terminal batches with an error", async () => {
    const batch = terminalBatch({
      id: "msgbatch_terminal_failure",
      request_counts: {
        canceled: 1,
        errored: 0,
        expired: 1,
        processing: 0,
        succeeded: 0,
      },
    });
    await tracedCreate(batch);
    const pending = (await backgroundLogger.drain()) as TestRow[];

    await completeAnthropicBatchTrace({
      batch,
      params: batchParams,
      results: [],
    });
    const rows = mergeRowBatch([
      ...pending,
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

  it("flushes between large creation and completion chunks", async () => {
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
    const flush = vi.spyOn(backgroundLogger, "flush");
    const message = {
      content: [{ text: "ok", type: "text" }],
      id: "msg_chunked",
      model: "claude-resolved",
      role: "assistant",
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as const;

    try {
      await tracedCreate(batch, params);
      expect(flush).toHaveBeenCalled();
      await backgroundLogger.drain();
      flush.mockClear();

      await completeAnthropicBatchTrace({
        batch,
        params,
        results: params.requests.map((request) => ({
          custom_id: request.custom_id,
          result: { message, type: "succeeded" as const },
        })),
      });
      expect(flush).toHaveBeenCalled();
    } finally {
      flush.mockRestore();
    }
  });

  it("skips tracing invalid or duplicate inputs", async () => {
    const params = {
      requests: [batchParams.requests[0], batchParams.requests[0]],
    } as AnthropicBatchCreateParams;
    await tracedCreate(terminalBatch({ id: "msgbatch_invalid" }), params);
    expect(await backgroundLogger.drain()).toEqual([]);
  });
});
