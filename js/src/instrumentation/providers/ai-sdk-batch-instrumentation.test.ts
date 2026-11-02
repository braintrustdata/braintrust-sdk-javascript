import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  startAISDKBatchTrace,
  completeAISDKBatchTrace,
} from "../../ai-sdk-batch";
import { _exportsForTestingOnly } from "../../logger/testing";
import { initLogger, startSpan, withCurrent } from "../../logger/core";
import { configureNode } from "../../node/config";
import type {
  AISDKBatchItem,
  AISDKBatchRequest,
  CompleteAISDKBatchTraceArgs,
} from "../../vendor-sdk-types/ai-sdk-batch";
import { wrapAISDK } from "../../wrappers/ai-sdk";
import { registerInstrumentation } from "../registrations/aisdk";
import { resetInstrumentationForTest } from "../test-utils/reset";
import { configureInstrumentation } from "../registry";

import { SpanComponentsV4 } from "../../../util/span_identifier_v4";

configureNode();
const requests: AISDKBatchRequest[] = [
  { id: "one", type: "text", model: "test/model", prompt: "Hello" },
  {
    id: "two",
    type: "text",
    model: "test/model",
    messages: [{ role: "user", content: "World" }],
  },
];
const results: AISDKBatchItem[] = [
  {
    id: "two",
    type: "text",
    status: "succeeded",
    text: "World!",
    content: [{ type: "text", text: "World!" }],
    finishReason: "stop",
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  },
  {
    id: "one",
    type: "text",
    status: "failed",
    error: { message: "Request rejected" },
  },
];
type TestRow = {
  id: string;
  span_id: string;
  root_span_id: string;
  span_parents: string[];
  span_attributes?: { name: string };
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  error?: string;
};
let sequence = 0;

describe("manual AI SDK batch capture", () => {
  let background: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let batch: { version: 2; id: string; provider: string };
  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });
  beforeEach(() => {
    background = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "ai-sdk-batch.test",
      projectId: "test-project-id",
    });
    resetInstrumentationForTest();
    registerInstrumentation();
    batch = { version: 2, id: `batch-${sequence++}`, provider: "gateway" };
  });
  afterEach(() => {
    resetInstrumentationForTest();
    vi.unstubAllEnvs();
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("leaves ordinary batch lifecycle calls untouched even with the plugin and wrapAISDK enabled", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const sdk = {
      experimental_startBatch: vi.fn(async () => batch),
      experimental_getBatchStatus: vi.fn(async () => ({ status: "completed" })),
      experimental_getBatchResults: vi.fn(() => stream),
      experimental_cancelBatch: vi.fn(async () => undefined),
    };
    const wrapped = wrapAISDK(sdk);
    for (const key of Object.keys(sdk) as Array<keyof typeof sdk>)
      expect(wrapped[key]).toBe(sdk[key]);
    expect(await wrapped.experimental_startBatch()).toBe(batch);
    await wrapped.experimental_getBatchStatus();
    expect(wrapped.experimental_getBatchResults()).toBe(stream);
    await wrapped.experimental_cancelBatch();
    expect(await background.drain()).toEqual([]);
  });

  it("captures inputs and unordered outcomes under the submitting parent without leaking secrets", async () => {
    const parent = startSpan({ name: "submitter" });
    const submission = {
      ...batch,
      status: "pending" as const,
      providerMetadata: {
        gateway: { asyncJob: { webhookSigningSecret: "signing-secret" } },
      },
    };
    const context = await withCurrent(parent, () =>
      startAISDKBatchTrace({ batch: submission, requests }),
    );
    expect(context).toBeTypeOf("string");
    await completeAISDKBatchTrace({
      batch,
      requests,
      context,
      results,
      status: {
        status: "completed",
        requestCounts: { total: 2, completed: 1, failed: 1, pending: 0 },
      },
    });
    parent.end();
    const rows = (await background.drain()) as TestRow[];
    const task = rows.find((row) => row.span_attributes?.name === "ai.batch")!;
    const children = rows.filter(
      (row) => row.span_attributes?.name === "ai.batch.request",
    );
    expect(task.span_parents).toEqual([parent.spanId]);
    expect(task.metadata).toMatchObject({
      status: "completed",
      request_counts: { total: 2 },
    });
    expect(children).toHaveLength(2);
    expect(children.every((row) => row.span_parents[0] === task.span_id)).toBe(
      true,
    );
    expect(
      children.find((row) => row.metadata.request_id === "two"),
    ).toMatchObject({
      output: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "World!" }],
          },
        },
      ],
      metrics: {
        prompt_tokens: 5,
        completion_tokens: 2,
        tokens: 7,
        end: expect.any(Number),
      },
    });
    expect(
      children.find((row) => row.metadata.request_id === "one")?.error,
    ).toContain("Request rejected");
    expect(JSON.stringify(rows)).not.toContain("signing-secret");
    for (const secret of ["Hello", "World", "signing-secret"])
      expect(context).not.toContain(secret);
  });

  it("resumes in a different parent without process-local tracking and merges repeated completion", async () => {
    const context = await startAISDKBatchTrace({ batch, requests });
    const initial = (await background.drain()) as TestRow[];
    resetInstrumentationForTest();
    registerInstrumentation();
    const worker = startSpan({ name: "worker" });
    const args = {
      batch,
      requests: [...requests].reverse(),
      context,
      results,
      status: { status: "completed" as const },
    };
    await withCurrent(worker, () => completeAISDKBatchTrace(args));
    await withCurrent(worker, () => completeAISDKBatchTrace(args));
    const ended = ((await background.drain()) as TestRow[]).filter(
      (row) => row.id !== worker.id,
    );
    expect(ended.map((row) => row.id).sort()).toEqual(
      initial.map((row) => row.id).sort(),
    );
    for (const row of ended) {
      expect(row.root_span_id).toBe(
        initial.find((original) => original.id === row.id)!.root_span_id,
      );
      expect(row.metrics.end).toBeDefined();
    }
    worker.end();
  });

  it("does not persist propagated event payloads in trace context", async () => {
    const parent = startSpan({
      name: "submitter",
      propagatedEvent: { metadata: { secret: "private-payload" } },
    });
    const context = await withCurrent(parent, () =>
      startAISDKBatchTrace({ batch, requests }),
    );
    expect(
      SpanComponentsV4.fromStr(JSON.parse(context!).parent).data
        .propagated_event,
    ).toBeUndefined();
    parent.end();
  });

  it("keeps context independent of batch size", async () => {
    const first = await startAISDKBatchTrace({ batch, requests });
    await background.drain();
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...requests[0],
      id: String(i),
    }));
    const second = await startAISDKBatchTrace({ batch, requests: many });
    expect(JSON.parse(first!).inputDigest).toHaveLength(64);
    expect(JSON.parse(second!).inputDigest).toHaveLength(64);
    expect(Object.keys(JSON.parse(second!)).sort()).toEqual([
      "batch",
      "inputDigest",
      "parent",
      "startTime",
      "version",
    ]);
  });

  it("leaves incomplete results retryable and finishes when all records are supplied", async () => {
    const context = await startAISDKBatchTrace({ batch, requests });
    await completeAISDKBatchTrace({
      batch,
      requests,
      context,
      results: [results[0]],
      status: { status: "completed" },
    });
    const partial = (await background.drain()) as TestRow[];
    expect(
      partial.find((row) => row.span_attributes?.name === "ai.batch")?.metrics
        .end,
    ).toBeUndefined();
    expect(partial.filter((row) => row.metrics.end !== undefined)).toHaveLength(
      1,
    );
    await completeAISDKBatchTrace({
      batch,
      requests,
      context,
      results,
      status: { status: "completed" },
    });
    expect(
      ((await background.drain()) as TestRow[]).every(
        (row) => row.metrics.end !== undefined,
      ),
    ).toBe(true);
  });

  it("leaves nonterminal outcomes pending even if results are supplied", async () => {
    const context = await startAISDKBatchTrace({ batch, requests });
    await completeAISDKBatchTrace({
      batch,
      requests,
      context,
      results,
      status: { status: "pending" },
    });
    expect(
      ((await background.drain()) as TestRow[]).every(
        (row) => row.metrics.end === undefined,
      ),
    ).toBe(true);
  });

  it("closes unresolved children on terminal failure and preserves partial successes", async () => {
    const context = await startAISDKBatchTrace({
      batch,
      requests,
      startTime: 100,
    });
    await completeAISDKBatchTrace({
      batch,
      requests,
      context,
      results: [results[0]],
      status: {
        status: "failed",
        rawStatus: "cancelled",
        error: { message: "Cancelled" },
      },
      endTime: 90,
    });
    const rows = (await background.drain()) as TestRow[];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.metrics.end === 100)).toBe(true);
    expect(rows.filter((row) => row.error)).toHaveLength(2);
  });

  it.each(["unknown", "duplicate"])(
    "does not close a completed batch with %s result IDs",
    async (kind) => {
      const context = await startAISDKBatchTrace({ batch, requests });
      await completeAISDKBatchTrace({
        batch,
        requests,
        context,
        status: { status: "completed" },
        results:
          kind === "duplicate"
            ? [...results, results[0]]
            : [results[0], { ...results[1], id: "unknown" }],
      });
      const rows = (await background.drain()) as TestRow[];
      expect(
        rows.find((row) => row.span_attributes?.name === "ai.batch")?.metrics
          .end,
      ).toBeUndefined();
    },
  );

  it("supports collect-only capture with provider timestamps", async () => {
    await completeAISDKBatchTrace({
      batch,
      requests,
      results,
      status: { status: "completed", createdAt: "2026-01-01T00:00:00Z" },
      endTime: 1767225601,
    });
    const rows = (await background.drain()) as TestRow[];
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) =>
          row.metrics.start === 1767225600 && row.metrics.end === 1767225601,
      ),
    ).toBe(true);
    expect(
      rows
        .filter((row) => row.span_attributes?.name === "ai.batch.request")
        .every((row) => "input" in row),
    ).toBe(true);
  });

  it("rejects invalid or mismatched context without producing spans", async () => {
    const context = (await startAISDKBatchTrace({ batch, requests }))!;
    await background.drain();
    for (const invalid of [
      "invalid",
      JSON.stringify({ version: 99 }),
      JSON.stringify({ ...JSON.parse(context), parent: "invalid" }),
    ]) {
      await completeAISDKBatchTrace({
        batch,
        requests,
        results,
        context: invalid,
        status: { status: "completed" },
      });
    }
    await completeAISDKBatchTrace({
      batch: { ...batch, id: "wrong" },
      requests,
      results,
      context,
      status: { status: "completed" },
    });
    await completeAISDKBatchTrace({
      batch,
      requests: [requests[0]],
      results,
      context,
      status: { status: "completed" },
    });
    expect(await background.drain()).toEqual([]);
  });

  it("never consumes lazy provider results", async () => {
    const iterator = vi.fn();
    const lazy = { [Symbol.asyncIterator]: iterator };
    await completeAISDKBatchTrace({
      batch,
      requests,
      results: lazy as unknown as CompleteAISDKBatchTraceArgs["results"],
      status: { status: "completed" },
    });
    expect(iterator).not.toHaveBeenCalled();
    expect(await background.drain()).toEqual([]);
  });

  it("normalizes tool calls without executing tools", async () => {
    const execute = vi.fn();
    const toolRequests: AISDKBatchRequest[] = [
      {
        ...requests[0],
        instructions: "Use the tool",
        temperature: 0.1,
        tools: {
          weather: {
            description: "Weather lookup",
            inputSchema: { type: "object" },
            execute,
          },
        },
        toolChoice: { type: "tool", toolName: "weather" },
      },
    ];
    await completeAISDKBatchTrace({
      batch,
      requests: toolRequests,
      status: { status: "completed" },
      results: [
        {
          id: "one",
          type: "text",
          status: "succeeded",
          finishReason: "tool-calls",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "weather",
              input: { city: "Paris" },
            },
          ],
          response: { modelId: "resolved-model" },
        },
      ],
    });
    const rows = (await background.drain()) as TestRow[];
    expect(
      rows.find((row) => row.span_attributes?.name === "ai.batch.request"),
    ).toMatchObject({
      input: [
        { role: "system", content: "Use the tool" },
        { role: "user", content: "Hello" },
      ],
      metadata: {
        model: "resolved-model",
        temperature: 0.1,
        tools: [
          {
            type: "function",
            function: {
              name: "weather",
              description: "Weather lookup",
              parameters: { type: "object" },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "weather" } },
      },
      output: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves remote images and omits inline bytes by default", async () => {
    vi.stubEnv("BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS", "false");
    await startAISDKBatchTrace({
      batch,
      requests: [
        {
          ...requests[0],
          prompt: undefined,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", image: "https://example.test/picture.png" },
                {
                  type: "image",
                  image: "data:image/png;base64,aW5saW5lLXNlY3JldA==",
                },
              ],
            },
          ],
        },
      ],
    });
    const rows = await background.drain();
    expect(JSON.stringify(rows)).toContain("https://example.test/picture.png");
    expect(JSON.stringify(rows)).not.toContain("aW5saW5lLXNlY3JldA==");
  });

  it("skips unsupported inputs and disabled capture", async () => {
    expect(
      await startAISDKBatchTrace({
        batch,
        requests: [requests[0], requests[0]],
      }),
    ).toBeUndefined();
    expect(
      await startAISDKBatchTrace({
        batch,
        requests: [{ ...requests[0], type: "image" }],
      }),
    ).toBeUndefined();
    resetInstrumentationForTest();
    configureInstrumentation({ integrations: { aisdk: false } });
    expect(await startAISDKBatchTrace({ batch, requests })).toBeUndefined();
    await completeAISDKBatchTrace({
      batch,
      requests,
      results,
      status: { status: "completed" },
    });
    expect(await background.drain()).toEqual([]);
  });
});
