import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _exportsForTestingOnly,
  _internalGetGlobalState,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger";
import { configureNode } from "../../node/config";
import {
  completeOpenAIBatchTrace,
  startOpenAIBatchTrace,
} from "../../openai-batch";
import type {
  OpenAIBatchCreateInputParams,
  OpenAIBatchJSONL,
  OpenAIFileLike,
} from "../../openai-batch-types";
import { BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY } from "./openai-batch-constants";
import { OpenAIPlugin } from "./openai-plugin";
import { SpanComponentsV4 } from "../../../util/span_identifier_v4";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

const chatInput = [
  {
    custom_id: "ok",
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    },
  },
  {
    custom_id: "bad",
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "gpt-test",
      messages: [{ role: "user", content: "fail" }],
    },
  },
];

async function startTestBatchTrace(args: {
  input: OpenAIBatchJSONL;
  inputFile: OpenAIFileLike;
  params: OpenAIBatchCreateInputParams;
}) {
  return await startOpenAIBatchTrace({
    ...args,
    client: {
      batches: {
        create: async (params) => ({
          id: `batch_${args.inputFile.id}`,
          ...params,
          status: "validating",
        }),
      },
    },
  });
}

function chunkedJSONLResponse(
  records: unknown[],
  beforeFirstChunk?: () => Promise<void>,
): Response {
  const bytes = new TextEncoder().encode(
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  let offset = 0;
  return new Response(
    new ReadableStream(
      {
        async pull(controller) {
          if (offset === 0) {
            await beforeFirstChunk?.();
          }
          if (offset < bytes.length) {
            controller.enqueue(bytes.slice(offset, offset + 7));
            offset += 7;
          } else {
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    ),
  );
}

describe("OpenAI Batch instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let plugin: OpenAIPlugin;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    _internalGetGlobalState()._internalSetTraceContextSigningSecret(
      "openai-batch-test-secret",
    );
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openai-batch-instrumentation.test.ts",
      projectId: "test-project-id",
    });
    plugin = new OpenAIPlugin();
    plugin.enable();
  });

  afterEach(() => {
    plugin.disable();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("creates a batch and starts deterministic pending spans", async () => {
    const inputFile = { id: "file_input", filename: "batch.jsonl" };
    const input = chatInput.map((record) => ({
      ...record,
      body: { ...record.body, user: "not-span-metadata" },
    }));
    const sourceParams = {
      endpoint: "/v1/chat/completions" as const,
      completion_window: "24h" as const,
      metadata: { user: "value" },
    };
    const params = await startTestBatchTrace({
      inputFile,
      input: input.map((record) => JSON.stringify(record)).join("\n"),
      params: sourceParams,
    });

    expect(params).toMatchObject({
      input_file_id: "file_input",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
      metadata: {
        user: "value",
        [BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY]: expect.any(String),
      },
    });
    expect(sourceParams.metadata).toEqual({ user: "value" });
    expect(inputFile).toEqual({ id: "file_input", filename: "batch.jsonl" });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    const task = rows.find(
      (row) => row.span_attributes?.name === "openai.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "Chat Completion",
    );
    expect(task).toMatchObject({
      metadata: { provider: "openai" },
      span_attributes: { type: "task" },
    });
    expect(task?.input).toBeUndefined();
    expect(task?.metrics).not.toHaveProperty("end");
    expect(task?.span_parents).toEqual([]);
    expect(children).toHaveLength(2);
    expect(children.map((row) => row.input?.[0]?.content).sort()).toEqual([
      "fail",
      "hi",
    ]);
    expect(children[0]?.metrics).not.toHaveProperty("end");
    expect(
      children.find((row) => row.input?.[0]?.content === "hi"),
    ).toMatchObject({
      input: [{ role: "user", content: "hi" }],
      metadata: { model: "gpt-test", provider: "openai" },
    });
    expect(
      children.find((row) => row.input?.[0]?.content === "hi")?.metadata,
    ).not.toHaveProperty("user");
  });

  it("does not start spans when OpenAI returns a different batch context", async () => {
    const batch = await startOpenAIBatchTrace({
      inputFile: { id: "file_mismatched_response" },
      input: [chatInput[0]],
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
      client: {
        batches: {
          create: async (params) => ({
            ...params,
            id: "batch_mismatched_response",
            endpoint: "/v1/responses",
            status: "validating",
          }),
        },
      },
    });

    expect(batch.endpoint).toBe("/v1/responses");
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("keeps separate batch operations distinct when they reuse an input file", async () => {
    const args = {
      inputFile: { id: "file_reused" },
      input: [chatInput[0]],
      params: {
        endpoint: "/v1/chat/completions" as const,
        completion_window: "24h" as const,
      },
    };

    const first = await startTestBatchTrace(args);
    const firstRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const second = await startTestBatchTrace(args);
    const secondRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;

    expect(first.metadata?.[BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY]).not.toBe(
      second.metadata?.[BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY],
    );
    expect(firstRows).toHaveLength(2);
    expect(secondRows).toHaveLength(2);
    const firstIds = new Set(firstRows.map((row) => row.id));
    expect(secondRows.some((row) => firstIds.has(row.id))).toBe(false);
  });

  it("signs and verifies batch context with WebCrypto", async () => {
    const params = await startTestBatchTrace({
      inputFile: { id: "file_webcrypto" },
      input: [chatInput[0]],
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });
    expect(params.metadata).toHaveProperty(BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY);
    await backgroundLogger.drain();

    await completeOpenAIBatchTrace({
      batch: {
        id: "batch_webcrypto",
        endpoint: params.endpoint,
        input_file_id: params.input_file_id,
        status: "completed",
        completed_at: 200,
        metadata: params.metadata,
      },
      input: [chatInput[0]],
      outputFile: [
        {
          custom_id: "ok",
          response: {
            status_code: 200,
            body: { choices: [], usage: { total_tokens: 0 } },
          },
        },
      ],
    });
    expect(await backgroundLogger.drain()).toHaveLength(2);
  });

  it("does not send propagated span event data to OpenAI", async () => {
    const parent = startSpan({
      name: "sensitive-parent",
      propagatedEvent: { metadata: { secret: "do-not-send" } },
    });
    const batch = await withCurrent(parent, () =>
      startTestBatchTrace({
        inputFile: { id: "file_minimal_parent" },
        input: [chatInput[0]],
        params: {
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        },
      }),
    );
    parent.end();

    const serialized = JSON.parse(
      batch.metadata?.[BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY] ?? "null",
    ) as { parent?: unknown; version?: unknown } | null;
    expect(serialized?.version).toBe(1);
    expect(typeof serialized?.parent).toBe("string");
    const exported = SpanComponentsV4.fromStr(serialized?.parent as string);
    expect(exported.data.propagated_event).toBeUndefined();
  });

  it("handles file promise rejections on early completion paths", async () => {
    const batch = {
      id: "batch_in_progress",
      endpoint: "/v1/chat/completions",
      input_file_id: "file_input",
      status: "in_progress",
    };

    await expect(
      completeOpenAIBatchTrace({
        batch,
        input: chatInput,
        outputFile: Promise.reject(new Error("output unavailable")),
        errorFile: Promise.reject(new Error("errors unavailable")),
      }),
    ).resolves.toBe(batch);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("completes successful and failed spans from resumable files", async () => {
    const params = await startTestBatchTrace({
      inputFile: { id: "file_input" },
      input: chatInput,
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });
    const pendingRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const pendingIds = pendingRows.map((row) => row.id).sort();
    const batch = {
      id: "batch_complete",
      endpoint: params.endpoint,
      input_file_id: params.input_file_id,
      completion_window: params.completion_window,
      status: "completed",
      completed_at: 140,
      request_counts: { completed: 1, failed: 1, total: 2 },
      metadata: params.metadata,
    };
    const outputRecords = [
      {
        custom_id: "ok",
        response: {
          status_code: 200,
          body: {
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello 👋" },
              },
            ],
            model: "gpt-resolved",
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          },
        },
      },
    ];
    const errorRecords = [
      { custom_id: "bad", error: { code: "server_error", message: "failed" } },
    ];
    let readersStarted = 0;
    let releaseReaders: (() => void) | undefined;
    const bothReadersStarted = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    const waitForBothReaders = async () => {
      readersStarted++;
      if (readersStarted === 2) {
        releaseReaders?.();
      }
      await bothReadersStarted;
    };
    const outputResponse = chunkedJSONLResponse(
      outputRecords,
      waitForBothReaders,
    );
    const errorResponse = chunkedJSONLResponse(
      errorRecords,
      waitForBothReaders,
    );
    const completedAt = Date.now() / 1000 + 60;
    batch.completed_at = completedAt;

    await expect(
      completeOpenAIBatchTrace({
        batch,
        input: chatInput,
        outputFile: Promise.resolve(outputResponse),
        errorFile: Promise.resolve(errorResponse),
      }),
    ).resolves.toBe(batch);
    expect(readersStarted).toBe(2);
    expect(outputResponse.bodyUsed).toBe(false);
    expect(errorResponse.bodyUsed).toBe(false);
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.id).sort()).toEqual(pendingIds);
    const task = rows.find(
      (row) => row.span_attributes?.name === "openai.batch",
    );
    const children = rows.filter(
      (row) => row.span_attributes?.name === "Chat Completion",
    );
    expect(task).toMatchObject({
      metrics: { end: completedAt },
    });
    expect(task?.output).toBeUndefined();
    expect(children.find((row) => row.output !== undefined)).toMatchObject({
      metadata: { model: "gpt-resolved", provider: "openai" },
      metrics: {
        completion_tokens: 3,
        end: completedAt,
        prompt_tokens: 2,
        tokens: 5,
      },
      output: [
        { index: 0, message: { role: "assistant", content: "hello 👋" } },
      ],
    });
    expect(children.find((row) => row.error !== undefined)?.error).toContain(
      "failed",
    );

    await completeOpenAIBatchTrace({
      batch,
      input: chatInput,
      outputFile: Promise.resolve(chunkedJSONLResponse(outputRecords)),
      errorFile: Promise.resolve(chunkedJSONLResponse(errorRecords)),
    });
    const replayRows = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    expect(replayRows.map((row) => row.id).sort()).toEqual(pendingIds);
  });

  it("leaves a completed batch pending until all results are available", async () => {
    const batch = await startTestBatchTrace({
      inputFile: { id: "file_incomplete" },
      input: chatInput,
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });
    await backgroundLogger.drain();

    await completeOpenAIBatchTrace({
      batch: {
        ...batch,
        status: "completed",
        completed_at: 400,
        request_counts: { completed: 1, failed: 1, total: 2 },
      },
      input: chatInput,
      outputFile: [
        {
          custom_id: "ok",
          response: {
            status_code: 200,
            body: { choices: [], model: "gpt-resolved" },
          },
        },
      ],
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const task = rows.find(
      (row) => row.span_attributes?.name === "openai.batch",
    );
    expect(task?.metrics).not.toHaveProperty("end");
    expect(task?.output).toBeUndefined();
  });

  it("rejects completion input that does not match the signed batch input", async () => {
    const params = await startTestBatchTrace({
      inputFile: { id: "file_mismatched" },
      input: chatInput,
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });
    await backgroundLogger.drain();

    await completeOpenAIBatchTrace({
      batch: {
        id: "batch_mismatched",
        endpoint: params.endpoint,
        input_file_id: params.input_file_id,
        status: "completed",
        completed_at: 400,
        request_counts: { completed: 1, failed: 1, total: 2 },
        metadata: params.metadata,
      },
      input: chatInput.map((record) => ({
        ...record,
        body: {
          ...record.body,
          messages: [{ role: "user", content: `changed-${record.custom_id}` }],
        },
      })),
      outputFile: [
        {
          custom_id: "ok",
          response: {
            status_code: 200,
            body: { choices: [], model: "gpt-resolved" },
          },
        },
      ],
      errorFile: [{ custom_id: "bad", error: { message: "expected failure" } }],
    });

    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("falls back from invalid provider terminal timestamps", async () => {
    const params = await startTestBatchTrace({
      inputFile: { id: "file_invalid_timestamp" },
      input: [chatInput[0]],
      params: {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });
    await backgroundLogger.drain();
    const beforeCompletion = Date.now() / 1000;

    await completeOpenAIBatchTrace({
      batch: {
        id: "batch_invalid_timestamp",
        endpoint: params.endpoint,
        input_file_id: params.input_file_id,
        status: "completed",
        completed_at: beforeCompletion - 1,
        request_counts: { completed: 1, failed: 0, total: 1 },
        metadata: params.metadata,
      },
      input: [chatInput[0]],
      outputFile: [
        {
          custom_id: "ok",
          response: {
            status_code: 200,
            body: { choices: [], model: "gpt-resolved" },
          },
        },
      ],
      webhook: {
        type: "batch.completed",
        created_at: beforeCompletion - 1,
        data: { id: "batch_invalid_timestamp" },
      },
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    for (const row of rows) {
      expect(row.metrics?.end).toEqual(expect.any(Number));
      expect(row.metrics.end).toBeGreaterThanOrEqual(beforeCompletion);
    }
  });

  it("maps Responses records from async input and validates webhook context", async () => {
    async function* input() {
      yield {
        custom_id: "response_1",
        method: "POST",
        url: "/v1/responses",
        body: { model: "gpt-test", input: "hello" },
      };
    }
    const params = await startTestBatchTrace({
      inputFile: { id: "file_responses" },
      input: input(),
      params: { endpoint: "/v1/responses", completion_window: "24h" },
    });
    await backgroundLogger.drain();
    const batch = {
      id: "batch_responses",
      endpoint: params.endpoint,
      input_file_id: params.input_file_id,
      status: "completed",
      completed_at: 260,
      request_counts: { completed: 1, failed: 0, total: 1 },
      metadata: params.metadata,
    };
    const outputFile = [
      {
        custom_id: "response_1",
        response: {
          status_code: 200,
          body: {
            id: "resp_1",
            model: "gpt-test",
            output: [{ type: "message", role: "assistant", content: [] }],
            usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
          },
        },
      },
    ];
    const completedAt = Date.now() / 1000 + 60;
    batch.completed_at = completedAt;

    await completeOpenAIBatchTrace({
      batch,
      input: input(),
      outputFile,
      webhook: {
        type: "batch.completed",
        created_at: 260,
        data: { id: batch.id },
      },
    });
    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const responseSpan = rows.find(
      (row) => row.span_attributes?.name === "openai.responses.create",
    );
    expect(responseSpan).toMatchObject({
      metadata: {
        model: "gpt-test",
        provider: "openai",
      },
      metrics: {
        completion_tokens: 6,
        end: completedAt,
        prompt_tokens: 4,
        tokens: 10,
      },
      output: [{ type: "message", role: "assistant", content: [] }],
    });
    expect(responseSpan?.metrics).not.toHaveProperty("time_to_first_token");

    await completeOpenAIBatchTrace({
      batch,
      input: input(),
      outputFile,
      webhook: { type: "batch.completed", data: { id: "another_batch" } },
    });
    expect(await backgroundLogger.drain()).toEqual([]);
  });

  it("ends a result span when output processing throws", async () => {
    const params = await startTestBatchTrace({
      inputFile: { id: "file_invalid_output" },
      input: [
        {
          custom_id: "response_1",
          method: "POST",
          url: "/v1/responses",
          body: { model: "gpt-test", input: "hello" },
        },
      ],
      params: { endpoint: "/v1/responses", completion_window: "24h" },
    });
    await backgroundLogger.drain();

    const output = new Proxy([], {
      get(target, property, receiver) {
        if (property === "map") {
          throw new Error("could not process output");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const completedAt = Date.now() / 1000 + 60;
    await completeOpenAIBatchTrace({
      batch: {
        id: "batch_invalid_output",
        endpoint: params.endpoint,
        input_file_id: params.input_file_id,
        status: "completed",
        completed_at: completedAt,
        metadata: params.metadata,
      },
      input: [
        {
          custom_id: "response_1",
          method: "POST",
          url: "/v1/responses",
          body: { model: "gpt-test", input: "hello" },
        },
      ],
      outputFile: [
        {
          custom_id: "response_1",
          response: {
            status_code: 200,
            body: { output },
          },
        },
      ],
    });

    const rows = (await backgroundLogger.drain()) as Array<Record<string, any>>;
    const child = rows.find(
      (row) => row.span_attributes?.name === "openai.responses.create",
    );
    expect(child?.error).toContain("could not process output");
    expect(child?.metrics?.end).toBe(completedAt);
  });

  it("leaves conflicting reserved metadata untouched", async () => {
    let inputReads = 0;
    async function* input() {
      inputReads++;
      yield* chatInput;
    }
    const params = await startTestBatchTrace({
      inputFile: { id: "file_input" },
      input: input(),
      params: {
        endpoint: "/v1/responses",
        completion_window: "24h",
        metadata: { [BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY]: "user-owned" },
      },
    });
    expect(params.metadata).toEqual({
      [BRAINTRUST_OPENAI_BATCH_CONTEXT_KEY]: "user-owned",
    });
    expect(inputReads).toBe(0);
    expect(await backgroundLogger.drain()).toEqual([]);
  });
});
