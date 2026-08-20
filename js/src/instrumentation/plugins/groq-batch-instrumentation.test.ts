import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { debugLogger } from "../../debug-logger";
import {
  _exportsForTestingOnly,
  _internalGetGlobalState,
  initLogger,
  traced,
} from "../../logger";
import { configureNode } from "../../node/config";
import {
  bindGroqBatchTrace,
  collectGroqBatchTrace,
  failGroqBatchTrace,
  startGroqBatchTrace,
} from "../../groq-batch";
import { GroqPlugin } from "./groq-plugin";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

const CONTEXT_KEY = "braintrust.batch_context";
const chatInput = [
  {
    custom_id: "ok",
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "llama-test",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      user: "not-allowlisted",
    },
  },
  {
    custom_id: "bad",
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "llama-test",
      messages: [{ role: "user", content: "fail" }],
    },
  },
];

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

async function startBatch(
  input: string | (() => Iterable<unknown>) = jsonl(chatInput),
) {
  const params = await startGroqBatchTrace({
    inputFile: { id: "file_input" },
    input,
    params: {
      endpoint: "/v1/chat/completions",
      completion_window: "48h",
      metadata: { caller: "value" },
    },
  });
  const batch = {
    id: "batch_test",
    ...params,
    status: "validating",
  };
  const traceContext = await bindGroqBatchTrace({ batch });
  if (!traceContext) {
    throw new Error("Expected the Groq batch trace to bind");
  }
  return {
    input,
    params,
    batch,
    traceContext,
  };
}

function chunkedResponse(records: unknown[]): Response {
  const bytes = new TextEncoder().encode(jsonl(records));
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset + 7));
          offset += 7;
        } else {
          controller.close();
        }
      },
    }),
  );
}

describe("Groq Batch instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let plugin: GroqPlugin;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    _internalGetGlobalState()._internalSetTraceContextSigningSecret(
      "groq-batch-test-secret",
    );
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "groq-batch-instrumentation.test.ts",
      projectId: "test-project-id",
    });
    plugin = new GroqPlugin();
    plugin.enable();
  });

  afterEach(() => {
    plugin.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  it("returns provider-ready params and starts pending task and LLM spans", async () => {
    const sourceMetadata = { caller: "value" };
    const params = await startGroqBatchTrace({
      inputFile: { id: "file_input" },
      input: jsonl(chatInput),
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "48h",
        metadata: sourceMetadata,
      },
    });

    expect(params).toMatchObject({
      input_file_id: "file_input",
      endpoint: "/v1/chat/completions",
      completion_window: "48h",
      metadata: {
        caller: "value",
        [CONTEXT_KEY]: expect.any(String),
      },
    });
    expect(sourceMetadata).toEqual({ caller: "value" });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const task = rows.find((row) => row.span_attributes?.name === "groq.batch");
    const children = rows.filter(
      (row) => row.span_attributes?.name === "groq.chat.completions.create",
    );
    expect(rows).toHaveLength(3);
    expect(task).toMatchObject({
      metadata: { provider: "groq" },
      span_attributes: { type: "task" },
      span_parents: [],
    });
    expect(task?.metrics).not.toHaveProperty("end");
    expect(children).toHaveLength(2);
    expect(
      children.every((row) => row.root_span_id === task?.root_span_id),
    ).toBe(true);
    expect(children.map((row) => row.input?.[0]?.content).sort()).toEqual([
      "fail",
      "hi",
    ]);
    expect(
      children.find((row) => row.input?.[0]?.content === "hi"),
    ).toMatchObject({
      metadata: {
        model: "llama-test",
        provider: "groq",
        temperature: 0,
      },
    });
    expect(
      children.find((row) => row.input?.[0]?.content === "hi")?.metadata,
    ).not.toHaveProperty("user");
  });

  it("flushes large batch span writes in bounded chunks", async () => {
    const flushSpy = vi.spyOn(backgroundLogger, "flush");
    const input = Array.from({ length: 1001 }, (_, index) => ({
      custom_id: `request-${index}`,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: "llama-test",
        messages: [{ role: "user", content: `prompt-${index}` }],
      },
    }));

    await startGroqBatchTrace({
      inputFile: { id: "file_large" },
      input: () => input.values(),
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });

    expect(flushSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(await backgroundLogger.drain()).toHaveLength(1002);
  });

  it("preserves a collection repair path when a partial start cannot be closed", async () => {
    const originalLog = backgroundLogger.log.bind(backgroundLogger);
    let logCalls = 0;
    vi.spyOn(backgroundLogger, "log").mockImplementation((items) => {
      logCalls += 1;
      if (logCalls > 1) {
        throw new Error("simulated start child emission failure");
      }
      originalLog(items);
    });

    const params = await startGroqBatchTrace({
      inputFile: { id: "file_incomplete_start" },
      input: jsonl(chatInput),
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
        metadata: { caller: "value" },
      },
    });

    expect(params.metadata?.[CONTEXT_KEY]).toEqual(expect.any(String));
    expect(JSON.parse(params.metadata?.[CONTEXT_KEY] ?? "{}")).toMatchObject({
      repairInputs: true,
    });
    const partialRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(
      partialRows.find((row) => row.span_attributes?.name === "groq.batch")
        ?.metrics?.end,
    ).toBeUndefined();

    vi.mocked(backgroundLogger.log).mockRestore();
    const batch = {
      id: "batch_repaired_start",
      ...params,
      status: "validating",
    };
    const traceContext = await bindGroqBatchTrace({ batch });
    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 2, failed: 0, total: 2 },
      },
      traceContext,
      inputFile: jsonl(chatInput),
      outputFile: jsonl(
        chatInput.map((record) => ({
          custom_id: record.custom_id,
          response: { status_code: 200, body: { choices: [] } },
        })),
      ),
    });

    const repairedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(repairedRows).toHaveLength(3);
    expect(repairedRows.every((row) => row.metrics?.end !== undefined)).toBe(
      true,
    );
    expect(
      repairedRows
        .filter(
          (row) => row.span_attributes?.name === "groq.chat.completions.create",
        )
        .map((row) => row.input?.[0]?.content)
        .sort(),
    ).toEqual(["fail", "hi"]);
  });

  it("withholds signed context when replayable start input changes", async () => {
    let calls = 0;
    const params = await startGroqBatchTrace({
      inputFile: { id: "file_changed_start" },
      input: () => {
        calls += 1;
        return calls % 2 === 1 ? chatInput : [chatInput[0]];
      },
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
        metadata: { caller: "value" },
      },
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(params.metadata).toEqual({ caller: "value" });
    expect(params.metadata).not.toHaveProperty(CONTEXT_KEY);
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("completes successful and failed children from out-of-order streams", async () => {
    const { batch, input, traceContext } = await startBatch();
    await backgroundLogger.drain();
    const completedAt = Date.now() / 1000 + 10;
    const terminal = {
      ...batch,
      status: "completed",
      completed_at: completedAt,
      request_counts: { completed: 1, failed: 1, total: 2 },
    };
    const outputFile = chunkedResponse([
      {
        custom_id: "ok",
        response: {
          status_code: 200,
          body: {
            model: "llama-resolved",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "hello" },
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 1,
              total_tokens: 4,
            },
            x_groq: {
              usage: { dram_cached_tokens: 2, sram_cached_tokens: 1 },
            },
          },
        },
      },
    ]);
    const errorFile = chunkedResponse([
      {
        custom_id: "bad",
        error: { message: "request failed" },
      },
    ]);

    expect(
      await collectGroqBatchTrace({
        batch: terminal,
        traceContext,
        inputFile: input,
        outputFile,
        errorFile,
      }),
    ).toBe(terminal);
    expect(outputFile.bodyUsed).toBe(true);
    expect(errorFile.bodyUsed).toBe(true);

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const task = rows.find((row) => row.span_attributes?.name === "groq.batch");
    const ok = rows.find(
      (row) => row.output?.[0]?.message?.content === "hello",
    );
    const bad = rows.find((row) => row.error?.includes("request failed"));
    expect(task?.metrics?.end).toBe(completedAt);
    expect(ok).toMatchObject({
      metadata: { model: "llama-resolved", provider: "groq" },
      metrics: {
        completion_tokens: 1,
        prompt_cached_tokens: 3,
        prompt_tokens: 3,
        tokens: 4,
        end: completedAt,
      },
    });
    expect(bad?.metrics?.end).toBe(completedAt);
  });

  it("completes a batch from an output file alone when request counts are absent", async () => {
    const { batch, input, traceContext } = await startBatch();
    await backgroundLogger.drain();
    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
      },
      traceContext,
      inputFile: input,
      outputFile: jsonl(
        chatInput.map((record) => ({
          custom_id: record.custom_id,
          response: { status_code: 200, body: { choices: [] } },
        })),
      ),
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(
      rows.find((row) => row.span_attributes?.name === "groq.batch")?.error,
    ).toBeUndefined();
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("streams replayable completed results beyond the one-shot buffer", async () => {
    const recordCount = 18;
    const input = Array.from({ length: recordCount }, (_, index) => ({
      custom_id: `large-${index}`,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: "llama-test",
        messages: [{ role: "user", content: `prompt-${index}` }],
      },
    }));
    const started = await startBatch(() => input.values());
    await backgroundLogger.drain();
    const largeContent = "x".repeat(1024 * 1024);
    let resultFactoryCalls = 0;
    const outputFile = () => {
      resultFactoryCalls += 1;
      return input.map((record) => ({
        custom_id: record.custom_id,
        response: {
          status_code: 200,
          body: {
            choices: [
              { message: { role: "assistant", content: largeContent } },
            ],
          },
        },
      }));
    };

    await collectGroqBatchTrace({
      batch: {
        ...started.batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: {
          completed: recordCount,
          failed: 0,
          total: recordCount,
        },
      },
      traceContext: started.traceContext,
      inputFile: started.input,
      outputFile,
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const task = rows.find((row) => row.span_attributes?.name === "groq.batch");
    expect(resultFactoryCalls).toBeGreaterThanOrEqual(2);
    expect(rows).toHaveLength(recordCount + 1);
    expect(task?.error).toBeUndefined();
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("leaves one-shot staging overflow retryable", async () => {
    const recordCount = 18;
    const input = Array.from({ length: recordCount }, (_, index) => ({
      custom_id: `one-shot-${index}`,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: "llama-test",
        messages: [{ role: "user", content: `prompt-${index}` }],
      },
    }));
    const started = await startBatch(() => input.values());
    await backgroundLogger.drain();
    const largeContent = "x".repeat(1024 * 1024);
    const outputFile = (function* () {
      for (const record of input) {
        yield {
          custom_id: record.custom_id,
          response: {
            status_code: 200,
            body: {
              choices: [
                { message: { role: "assistant", content: largeContent } },
              ],
            },
          },
        };
      }
    })();

    await collectGroqBatchTrace({
      batch: {
        ...started.batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: {
          completed: recordCount,
          failed: 0,
          total: recordCount,
        },
      },
      traceContext: started.traceContext,
      inputFile: started.input,
      outputFile,
    });

    expect(await backgroundLogger.drain()).toEqual([]);

    await collectGroqBatchTrace({
      batch: {
        ...started.batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: {
          completed: recordCount,
          failed: 0,
          total: recordCount,
        },
      },
      traceContext: started.traceContext,
      inputFile: started.input,
      outputFile: () =>
        input.map((record) => ({
          custom_id: record.custom_id,
          response: {
            status_code: 200,
            body: {
              choices: [
                { message: { role: "assistant", content: largeContent } },
              ],
            },
          },
        })),
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(recordCount + 1);
    expect(rows.every((row) => row.error === undefined)).toBe(true);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("uses standard JSON semantics for iterable input records", async () => {
    const serializedRecord = {
      custom_id: "json-semantics",
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: "llama-test",
        messages: [{ role: "user", content: "normalized" }],
        omitted: undefined,
        array: [undefined],
      },
      omitted: undefined,
      toJSON() {
        return {
          custom_id: this.custom_id,
          method: this.method,
          url: this.url,
          body: this.body,
          omittedByToJSON: undefined,
        };
      },
    };
    const params = await startGroqBatchTrace({
      inputFile: { id: "file_json_semantics" },
      input: () => [serializedRecord],
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });
    const batch = {
      id: "batch_json_semantics",
      ...params,
      status: "validating",
    };
    const traceContext = await bindGroqBatchTrace({ batch });
    expect(traceContext).toMatchObject({ value: expect.any(String) });
    await backgroundLogger.drain();

    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 1, failed: 0, total: 1 },
      },
      traceContext,
      inputFile: JSON.stringify(serializedRecord),
      outputFile: jsonl([
        {
          custom_id: "json-semantics",
          response: { status_code: 200, body: { choices: [] } },
        },
      ]),
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("rejects a trace context bound to a different provider batch ID", async () => {
    const { batch, traceContext } = await startBatch();
    await backgroundLogger.drain();
    const inputFile = chunkedResponse(chatInput);
    const outputFile = chunkedResponse([
      {
        custom_id: "ok",
        response: { status_code: 200, body: { choices: [] } },
      },
      {
        custom_id: "bad",
        response: { status_code: 200, body: { choices: [] } },
      },
    ]);

    await collectGroqBatchTrace({
      batch: {
        ...batch,
        id: "batch_other",
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 2, failed: 0, total: 2 },
      },
      traceContext,
      inputFile,
      outputFile,
    });

    expect(inputFile.bodyUsed).toBe(false);
    expect(outputFile.bodyUsed).toBe(false);
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("leaves child emission failures retryable", async () => {
    const { batch, input, traceContext } = await startBatch();
    await backgroundLogger.drain();
    const originalLog = backgroundLogger.log.bind(backgroundLogger);
    let logCalls = 0;
    vi.spyOn(backgroundLogger, "log").mockImplementation((items) => {
      logCalls += 1;
      if (logCalls > 1) {
        throw new Error("simulated child emission failure");
      }
      originalLog(items);
    });

    const terminal = {
      ...batch,
      status: "completed",
      completed_at: Date.now() / 1000 + 10,
      request_counts: { completed: 2, failed: 0, total: 2 },
    };
    const outputFile = jsonl(
      chatInput.map((record) => ({
        custom_id: record.custom_id,
        response: { status_code: 200, body: { choices: [] } },
      })),
    );
    await collectGroqBatchTrace({
      batch: terminal,
      traceContext,
      inputFile: input,
      outputFile,
    });

    const partialRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const pendingTask = partialRows.find(
      (row) => row.span_attributes?.name === "groq.batch",
    );
    expect(pendingTask?.error).toBeUndefined();
    expect(pendingTask?.metrics?.end).toBeUndefined();

    vi.mocked(backgroundLogger.log).mockRestore();
    await collectGroqBatchTrace({
      batch: terminal,
      traceContext,
      inputFile: input,
      outputFile,
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const task = rows.find((row) => row.span_attributes?.name === "groq.batch");
    expect(rows).toHaveLength(3);
    expect(task?.error).toBeUndefined();
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("leaves failed batches retryable when a terminal child cannot be emitted", async () => {
    const { batch, input, traceContext } = await startBatch();
    await backgroundLogger.drain();
    const originalLog = backgroundLogger.log.bind(backgroundLogger);
    let logCalls = 0;
    vi.spyOn(backgroundLogger, "log").mockImplementation((items) => {
      logCalls += 1;
      if (logCalls > 1) {
        throw new Error("simulated terminal child emission failure");
      }
      originalLog(items);
    });

    const terminal = {
      ...batch,
      status: "failed",
      failed_at: Date.now() / 1000 + 10,
      request_counts: { completed: 1, failed: 1, total: 2 },
    };
    const outputFile = jsonl([
      {
        custom_id: "ok",
        response: { status_code: 200, body: { choices: [] } },
      },
    ]);
    const errorFile = jsonl([
      { custom_id: "bad", error: { message: "provider failure" } },
    ]);
    await collectGroqBatchTrace({
      batch: terminal,
      traceContext,
      inputFile: input,
      outputFile,
      errorFile,
    });

    const partialRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const pendingTask = partialRows.find(
      (row) => row.span_attributes?.name === "groq.batch",
    );
    expect(pendingTask?.error).toBeUndefined();
    expect(pendingTask?.metrics?.end).toBeUndefined();

    vi.mocked(backgroundLogger.log).mockRestore();
    await collectGroqBatchTrace({
      batch: terminal,
      traceContext,
      inputFile: input,
      outputFile,
      errorFile,
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
    expect(
      rows.find((row) => row.span_attributes?.name === "groq.batch")?.error,
    ).toContain("Groq Batch failed");
  });

  it("leaves completed batches pending when results are incomplete", async () => {
    const { batch, input, traceContext } = await startBatch();
    await backgroundLogger.drain();
    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 1, failed: 0, total: 2 },
      },
      traceContext,
      inputFile: input,
      outputFile: jsonl([
        {
          custom_id: "ok",
          response: {
            status_code: 200,
            body: { choices: [], usage: { total_tokens: 0 } },
          },
        },
      ]),
    });

    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("does not consume completed result files until all required sources are supplied", async () => {
    const { batch, traceContext } = await startBatch();
    await backgroundLogger.drain();
    const terminal = {
      ...batch,
      status: "completed",
      completed_at: Date.now() / 1000 + 10,
      request_counts: { completed: 1, failed: 1, total: 2 },
    };
    const outputFile = chunkedResponse([
      {
        custom_id: "ok",
        response: { status_code: 200, body: { choices: [] } },
      },
    ]);
    const errorFile = chunkedResponse([
      { custom_id: "bad", error: { message: "atomic failure" } },
    ]);
    const inputFile = chunkedResponse(chatInput);

    await collectGroqBatchTrace({
      batch: terminal,
      traceContext,
      inputFile,
      outputFile,
    });
    expect(inputFile.bodyUsed).toBe(false);
    expect(outputFile.bodyUsed).toBe(false);
    expect(await backgroundLogger.drain()).toEqual([]);

    await collectGroqBatchTrace({
      batch: terminal,
      traceContext,
      inputFile,
      errorFile,
    });
    expect(inputFile.bodyUsed).toBe(false);
    expect(errorFile.bodyUsed).toBe(false);
    expect(await backgroundLogger.drain()).toEqual([]);

    await collectGroqBatchTrace({
      batch: terminal,
      traceContext,
      inputFile,
      outputFile,
      errorFile,
    });
    expect(inputFile.bodyUsed).toBe(true);
    expect(outputFile.bodyUsed).toBe(true);
    expect(errorFile.bodyUsed).toBe(true);
    expect(await backgroundLogger.drain()).toHaveLength(3);
  });

  it("collects a complete batch under the active parent without signed context", async () => {
    const diagnostic = vi
      .spyOn(debugLogger, "debug")
      .mockImplementation(() => {});
    const completedAt = Date.now() / 1000 + 10;
    await traced(
      async () => {
        await collectGroqBatchTrace({
          batch: {
            id: "batch_collect_only",
            endpoint: "/v1/chat/completions",
            input_file_id: "file_collect_only",
            status: "completed",
            created_at: completedAt - 10,
            completed_at: completedAt,
            request_counts: { completed: 1, failed: 1, total: 2 },
          },
          inputFile: jsonl(chatInput),
          outputFile: jsonl([
            {
              custom_id: "ok",
              response: {
                status_code: 200,
                body: {
                  model: "llama-collected",
                  choices: [
                    {
                      index: 0,
                      finish_reason: "stop",
                      message: { role: "assistant", content: "collected" },
                    },
                  ],
                },
              },
            },
          ]),
          errorFile: jsonl([
            { custom_id: "bad", error: { message: "collected failure" } },
          ]),
        });
      },
      { name: "collect-parent" },
    );

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const parent = rows.find(
      (row) => row.span_attributes?.name === "collect-parent",
    );
    const task = rows.find((row) => row.span_attributes?.name === "groq.batch");
    expect(task?.span_parents).toEqual([parent?.span_id]);
    expect(parent?.root_span_id).toEqual(expect.any(String));
    expect(task?.root_span_id).toBe(parent?.root_span_id);
    expect(task?.metrics?.start).toBe(completedAt - 10);
    expect(task?.metrics?.end).toBe(completedAt);
    expect(rows).toHaveLength(4);
    expect(
      rows.find((row) => row.output?.[0]?.message?.content === "collected"),
    ).toMatchObject({
      input: [{ role: "user", content: "hi" }],
      metadata: { model: "llama-collected", provider: "groq" },
    });
    expect(
      rows.find((row) => row.error?.includes("collected failure")),
    ).toBeDefined();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("attempting collect-only tracing"),
      expect.any(Error),
    );
  });

  it.each(["completed", "failed"] as const)(
    "leaves a collect-only %s task pending when its child cannot be emitted",
    async (status) => {
      await traced(
        async () => {
          const originalLog = backgroundLogger.log.bind(backgroundLogger);
          let logCalls = 0;
          const logSpy = vi
            .spyOn(backgroundLogger, "log")
            .mockImplementation((items) => {
              logCalls += 1;
              if (logCalls > 1) {
                throw new Error(
                  "simulated collect-only child emission failure",
                );
              }
              originalLog(items);
            });
          await collectGroqBatchTrace({
            batch: {
              id: "batch_collect_only_emission_failure",
              endpoint: "/v1/chat/completions",
              input_file_id: "file_collect_only_emission_failure",
              status,
              created_at: Date.now() / 1000,
              completed_at: Date.now() / 1000 + 10,
              failed_at: Date.now() / 1000 + 10,
              request_counts: { completed: 1, failed: 0, total: 1 },
            },
            inputFile: jsonl([chatInput[0]]),
            outputFile: jsonl([
              {
                custom_id: "ok",
                response: { status_code: 200, body: { choices: [] } },
              },
            ]),
          });
          logSpy.mockRestore();
        },
        { name: "collect-only-emission-parent" },
      );

      const rows = (await backgroundLogger.drain()) as Array<
        Record<string, any>
      >;
      const task = rows.find(
        (row) => row.span_attributes?.name === "groq.batch",
      );
      expect(task?.error).toBeUndefined();
      expect(task?.metrics?.end).toBeUndefined();
    },
  );

  it("snapshots mutable collect-only result records before advancing the iterable", async () => {
    const sharedRecord = {
      custom_id: "ok",
      response: {
        status_code: 200,
        body: {
          choices: [
            { message: { role: "assistant", content: "first result" } },
          ],
        },
      },
    };
    const outputFile = (function* () {
      yield sharedRecord;
      sharedRecord.custom_id = "bad";
      sharedRecord.response.body.choices[0].message.content = "second result";
      yield sharedRecord;
    })();

    await traced(
      async () => {
        await collectGroqBatchTrace({
          batch: {
            id: "batch_mutable_collect_only",
            endpoint: "/v1/chat/completions",
            input_file_id: "file_mutable_collect_only",
            status: "completed",
            completed_at: Date.now() / 1000 + 10,
            request_counts: { completed: 2, failed: 0, total: 2 },
          },
          inputFile: jsonl(chatInput),
          outputFile,
        });
      },
      { name: "mutable-collect-parent" },
    );

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(
      rows.find((row) => row.input?.[0]?.content === "hi")?.output?.[0]?.message
        ?.content,
    ).toBe("first result");
    expect(
      rows.find((row) => row.input?.[0]?.content === "fail")?.output?.[0]
        ?.message?.content,
    ).toBe("second result");
  });

  it("rejects malformed completed results before emitting any updates", async () => {
    const { batch, input, traceContext } = await startBatch();
    await backgroundLogger.drain();
    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 1, failed: 1, total: 2 },
      },
      traceContext,
      inputFile: input,
      outputFile: jsonl([
        { custom_id: "ok", response: { body: { choices: [] } } },
      ]),
      errorFile: jsonl([
        { custom_id: "bad", error: { message: "valid failure" } },
      ]),
    });

    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("keeps the task pending when result totals disagree with request counts", async () => {
    const { batch, input, traceContext } = await startBatch();
    await backgroundLogger.drain();
    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 2, failed: 0, total: 2 },
      },
      traceContext,
      inputFile: input,
      outputFile: jsonl([
        {
          custom_id: "ok",
          response: { status_code: 200, body: { choices: [] } },
        },
      ]),
      errorFile: jsonl([
        { custom_id: "bad", error: { message: "counted failure" } },
      ]),
    });

    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("skips inconsistent collect-only batches without creating pending spans", async () => {
    await traced(
      async () => {
        await collectGroqBatchTrace({
          batch: {
            id: "batch_collect_only_incomplete",
            endpoint: "/v1/chat/completions",
            input_file_id: "file_collect_only_incomplete",
            status: "completed",
            completed_at: Date.now() / 1000 + 10,
            request_counts: { completed: 1, failed: 0, total: 2 },
          },
          inputFile: jsonl(chatInput),
          outputFile: jsonl([
            { custom_id: "ok", response: { body: { choices: [] } } },
          ]),
        });
      },
      { name: "incomplete-collect-parent" },
    );

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows.map((row) => row.span_attributes?.name)).toEqual([
      "incomplete-collect-parent",
    ]);
  });

  it("ends unresolved spans for failed batches despite inconsistent counts", async () => {
    const { batch, input, traceContext } = await startBatch();
    await backgroundLogger.drain();
    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "failed",
        failed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 0, failed: 0, total: 1 },
      },
      traceContext,
      inputFile: input,
      outputFile: jsonl([
        {
          custom_id: "ok",
          response: { status_code: 200, body: { choices: [] } },
        },
      ]),
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
    expect(
      rows.find((row) => row.span_attributes?.name === "groq.batch")?.error,
    ).toContain("Groq Batch failed");
    expect(
      rows.find((row) => row.error?.includes("Groq Batch failed")),
    ).toBeDefined();
  });

  it("fails every pending span after submission rejection", async () => {
    const { params, input } = await startBatch();
    await backgroundLogger.drain();
    const error = new Error("create rejected");

    await failGroqBatchTrace({ params, input, error });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
    expect(rows.every((row) => row.error?.includes("create rejected"))).toBe(
      true,
    );
  });

  it("replays iterable factories when a submission fails", async () => {
    let factoryCalls = 0;
    const input = () => {
      factoryCalls += 1;
      return chatInput.values();
    };
    const { params } = await startBatch(input);
    await backgroundLogger.drain();

    await failGroqBatchTrace({
      params,
      input,
      error: new Error("factory submission failed"),
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(factoryCalls).toBeGreaterThanOrEqual(2);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("validates a failure replay before writing any span updates", async () => {
    let mismatch = false;
    const input = () => (mismatch ? [chatInput[0]] : chatInput);
    const { params } = await startBatch(input);
    await backgroundLogger.drain();
    mismatch = true;

    await failGroqBatchTrace({
      params,
      input,
      error: new Error("mismatched submission failed"),
    });

    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("traces valid requests while skipping record-local input errors", async () => {
    const input = [
      chatInput[0],
      {
        custom_id: "invalid",
        method: "GET",
        url: "/v1/chat/completions",
        body: {},
      },
    ];
    const params = await startGroqBatchTrace({
      inputFile: { id: "file_invalid" },
      input: () => input,
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });

    expect(params.metadata?.[CONTEXT_KEY]).toEqual(expect.any(String));
    const startedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(startedRows).toHaveLength(2);
    expect(
      startedRows.find(
        (row) => row.span_attributes?.name === "groq.chat.completions.create",
      )?.input,
    ).toEqual([{ role: "user", content: "hi" }]);

    const batch = { id: "batch_invalid_line", ...params, status: "validating" };
    const traceContext = await bindGroqBatchTrace({ batch });
    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 1, failed: 0, total: 1 },
      },
      traceContext,
      inputFile: () => input,
      outputFile: jsonl([
        {
          custom_id: "ok",
          response: { status_code: 200, body: { choices: [] } },
        },
      ]),
    });

    const completedRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(completedRows).toHaveLength(2);
    expect(completedRows.every((row) => row.metrics?.end !== undefined)).toBe(
      true,
    );
  });

  it("supports a single input and result record beyond 16 MiB", async () => {
    const largeContent = "x".repeat(17 * 1024 * 1024);
    const input = [
      {
        custom_id: "large-record",
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model: "llama-test",
          messages: [{ role: "user", content: largeContent }],
        },
      },
    ];
    const params = await startGroqBatchTrace({
      inputFile: { id: "file_large_record" },
      input: () => input,
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });
    const batch = { id: "batch_large_record", ...params, status: "validating" };
    const traceContext = await bindGroqBatchTrace({ batch });

    expect(params.metadata?.[CONTEXT_KEY]).toEqual(expect.any(String));
    expect(await backgroundLogger.drain()).toHaveLength(2);

    await collectGroqBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: Date.now() / 1000 + 10,
        request_counts: { completed: 1, failed: 0, total: 1 },
      },
      traceContext,
      inputFile: () => input,
      outputFile: () => [
        {
          custom_id: "large-record",
          response: {
            status_code: 200,
            body: {
              choices: [
                { message: { role: "assistant", content: largeContent } },
              ],
            },
          },
        },
      ],
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.metrics?.end !== undefined)).toBe(true);
  });

  it("streams start inputs beyond the former 16 MiB staging limit", async () => {
    const recordCount = 17;
    let factoryCalls = 0;
    let recordsRead = 0;
    const content = "🙂".repeat(256 * 1024);
    const largeInput = Array.from({ length: recordCount }, (_, index) => ({
      custom_id: `large-input-${index}`,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        model: "llama-test",
        messages: [{ role: "user", content }],
      },
    }));
    const params = await startGroqBatchTrace({
      inputFile: { id: "file_non_ascii" },
      input: () => {
        factoryCalls += 1;
        return (function* () {
          for (const record of largeInput) {
            recordsRead += 1;
            yield record;
          }
        })();
      },
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });

    expect(params.metadata?.[CONTEXT_KEY]).toEqual(expect.any(String));
    expect(factoryCalls).toBeGreaterThanOrEqual(2);
    expect(recordsRead).toBe(factoryCalls * recordCount);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(recordCount + 1);
    expect(
      rows.filter(
        (row) => row.span_attributes?.name === "groq.chat.completions.create",
      ),
    ).toHaveLength(recordCount);
  });

  it("cancels response bodies when a staging limit stops consumption", async () => {
    const cancel = vi.fn();
    const oversizedRecord = jsonl([
      {
        ...chatInput[0],
        body: {
          ...chatInput[0].body,
          messages: [
            {
              role: "user",
              content: "🙂".repeat(4 * 1024 * 1024),
            },
          ],
        },
      },
    ]);
    const inputFile = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${oversizedRecord}\n`));
        },
        cancel,
      }),
    );

    await traced(
      async () => {
        await collectGroqBatchTrace({
          batch: {
            id: "batch_oversized_response",
            endpoint: "/v1/chat/completions",
            input_file_id: "file_oversized_response",
            status: "failed",
            failed_at: Date.now() / 1000,
          },
          inputFile,
        });
      },
      { name: "oversized-response-parent" },
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(inputFile.bodyUsed).toBe(true);
    await backgroundLogger.drain();
  });

  it("preserves conflicting metadata without creating spans", async () => {
    const params = await startGroqBatchTrace({
      inputFile: { id: "file_conflict" },
      input: () => [chatInput[0]],
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
        metadata: { [CONTEXT_KEY]: "caller-owned" },
      },
    });

    expect(params.metadata).toEqual({ [CONTEXT_KEY]: "caller-owned" });
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("does not include invalid file-source contents in diagnostics", async () => {
    const diagnostic = vi.spyOn(debugLogger, "debug");
    const secretSource = { secret: "do-not-log-this-value" };

    await collectGroqBatchTrace({
      batch: {
        id: "batch_invalid_source",
        endpoint: "/v1/chat/completions",
        input_file_id: "file_invalid_source",
        status: "completed",
      },
      inputFile: secretSource as never,
      outputFile: jsonl([]),
    });

    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("skipped invalid JSONL source"),
      expect.any(Error),
    );
    expect(
      diagnostic.mock.calls.some((call) => call.includes(secretSource)),
    ).toBe(false);
  });
});
