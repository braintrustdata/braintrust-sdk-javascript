import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  completeGeminiDeveloperBatchTrace,
  startGeminiDeveloperBatchTrace,
} from "../../google-genai-batch";
import {
  _exportsForTestingOnly,
  _internalGetGlobalState,
  initLogger,
  startSpan,
  withCurrent,
} from "../../logger";
import { configureNode } from "../../node/config";
import { mergeRowBatch } from "../../../util/index";
import {
  normalizeGoogleGenAIToolChoice,
  serializeGoogleGenAIContents,
  serializeGoogleGenAITools,
  serializeGoogleGenAIValue,
} from "./google-genai-shared";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

const model = "models/gemini-2.5-flash";
const inlineParams = {
  model,
  src: [
    {
      contents: [{ parts: [{ text: "One" }], role: "user" }],
      config: {
        httpOptions: { headers: { Authorization: "secret-header" } },
        optionalValue: undefined,
        stopSequences: ["STOP", undefined],
        temperature: 0,
        tools: [
          {
            functionDeclarations: [
              {
                description: "Look up the weather",
                name: "get_weather",
                parametersJsonSchema: {
                  properties: { city: { type: "string" } },
                  required: ["city"],
                  type: "object",
                },
              },
            ],
          },
          { googleSearch: {} },
        ],
        toolConfig: {
          functionCallingConfig: {
            allowedFunctionNames: ["get_weather"],
            mode: "ANY",
          },
        },
      },
      metadata: { private_request_label: "secret-metadata" },
    },
    {
      contents: [{ parts: [{ text: "Two" }], role: "user" }],
    },
  ],
};

describe("Google GenAI Batch instrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    _internalGetGlobalState()._internalSetTraceContextSigningSecret(
      "google-genai-batch-test-secret",
    );
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectId: "test-project-id",
      projectName: "google-genai-batch.test.ts",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
    vi.restoreAllMocks();
  });

  test("starts after create and completes inline requests deterministically", async () => {
    const created = {
      createTime: "2026-08-19T10:00:00.000Z",
      model,
      name: "batches/inline-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params: inlineParams,
    });

    expect(traceContext).toEqual(expect.any(String));
    const started = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(started).toHaveLength(3);
    const startedByName = Object.fromEntries(
      started.map((span) => [span.span_attributes.name, span]),
    );
    expect(startedByName["google-genai.batch"]).toMatchObject({
      metadata: {
        batch_name: "batches/inline-1",
        model,
        provider: "google",
      },
      span_attributes: { name: "google-genai.batch", type: "task" },
    });
    const startedChildren = started.filter(
      (span) => span.span_attributes.name === "generate_content",
    );
    expect(startedChildren).toHaveLength(2);
    expect(
      startedChildren.map((span) => span.input.contents[0].parts[0].text),
    ).toEqual(["One", "Two"]);
    expect(startedChildren[0]?.metadata).toMatchObject({
      batch_request_index: 0,
      model,
      provider: "google",
      stopSequences: ["STOP", null],
      temperature: 0,
      tools: [
        {
          function: {
            description: "Look up the weather",
            name: "get_weather",
            parameters: {
              properties: { city: { type: "string" } },
              required: ["city"],
              type: "object",
            },
          },
          type: "function",
        },
        { config: {}, type: "googleSearch" },
      ],
    });
    expect(startedChildren[0]?.input).not.toHaveProperty("config");
    expect(startedChildren[0]?.metadata).toMatchObject({
      tool_choice: {
        function: { name: "get_weather" },
        type: "function",
      },
    });
    expect(startedChildren[0]?.metadata).not.toHaveProperty("toolConfig");
    expect(JSON.stringify(startedChildren[0])).not.toContain("secret-header");
    expect(JSON.stringify(startedChildren[0])).not.toContain("secret-metadata");
    expect(startedChildren[0]?.metadata).not.toHaveProperty("httpOptions");
    expect(startedChildren[0]?.metadata).not.toHaveProperty(
      "batch_request_metadata",
    );

    const completed = {
      ...created,
      completionStats: {
        failedCount: "1",
        incompleteCount: "0",
        successfulCount: "1",
      },
      dest: {
        inlinedResponses: [
          {
            response: {
              candidates: [
                {
                  content: { parts: [{ text: "First" }], role: "model" },
                  groundingMetadata: {
                    webSearchQueries: ["first query"],
                  },
                },
              ],
              arbitraryExtension: "private-response-extension",
              modelVersion: "gemini-2.5-flash-001",
              parsed: { private: "derived-parsed-value" },
              sdkHttpResponse: {
                headers: { Authorization: "secret-response-header" },
              },
              usageMetadata: {
                cachedContentTokenCount: 2,
                candidatesTokensDetails: [
                  { modality: "AUDIO", tokenCount: 7 },
                  { modality: "IMAGE", tokenCount: 8 },
                ],
                candidatesTokenCount: 3,
                promptTokensDetails: [{ modality: "AUDIO", tokenCount: 9 }],
                promptTokenCount: 4,
                thoughtsTokenCount: 5,
                toolUsePromptTokenCount: 6,
                totalTokenCount: 18,
              },
              text: "First",
            },
          },
          { error: { code: 400, message: "Bad request" } },
        ],
      },
      endTime: "2026-08-19T10:01:00.000Z",
      state: "JOB_STATE_SUCCEEDED",
    };
    const returned = await completeGeminiDeveloperBatchTrace({
      batch: completed,
      params: inlineParams,
      traceContext,
    });

    expect(returned).toEqual({ batch: completed, traceContext });
    expect(returned.batch).toBe(completed);
    const completionRows = (await backgroundLogger.drain()) as Record<
      string,
      any
    >[];
    expect(completionRows).toHaveLength(3);
    expect(completionRows.map((span) => span.id).sort()).toEqual(
      started.map((span) => span.id).sort(),
    );
    expect(
      completionRows
        .map((span) => ({
          id: span.id,
          root_span_id: span.root_span_id,
          span_id: span.span_id,
          span_parents: span.span_parents,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(
      started
        .map((span) => ({
          id: span.id,
          root_span_id: span.root_span_id,
          span_id: span.span_id,
          span_parents: span.span_parents,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    const successful = completionRows.find(
      (span) => span.output?.modelVersion === "gemini-2.5-flash-001",
    );
    expect(successful).toMatchObject({
      metadata: {
        groundingMetadata: { webSearchQueries: ["first query"] },
        model: "gemini-2.5-flash-001",
        provider: "google",
      },
      metrics: {
        completion_audio_tokens: 7,
        completion_image_tokens: 8,
        completion_reasoning_tokens: 5,
        completion_tokens: 8,
        prompt_audio_tokens: 9,
        prompt_cached_tokens: 2,
        prompt_tokens: 10,
        tokens: 18,
      },
    });
    expect(JSON.stringify(successful)).not.toContain("secret-response-header");
    expect(JSON.stringify(successful)).not.toContain(
      "private-response-extension",
    );
    expect(successful?.output).not.toHaveProperty("parsed");
    expect(successful?.output).not.toHaveProperty("text");
    expect(
      completionRows.find((span) => span.error === "Bad request"),
    ).toBeDefined();
    expect(
      completionRows.find(
        (span) => span.span_attributes.name === "google-genai.batch",
      ),
    ).toMatchObject({
      metadata: {
        failed_request_count: 1,
        incomplete_request_count: 0,
        state: "JOB_STATE_SUCCEEDED",
        successful_request_count: 1,
      },
    });

    await completeGeminiDeveloperBatchTrace({
      batch: completed,
      params: inlineParams,
      traceContext,
    });
    const retried = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(retried.map((span) => span.id).sort()).toEqual(
      started.map((span) => span.id).sort(),
    );
  });

  test("repeating start reuses input-bound task and child identities", async () => {
    const created = {
      createTime: "2026-08-19T10:30:00.000Z",
      model,
      name: "batches/repeated-start-1",
      state: "JOB_STATE_PENDING",
    };
    const firstContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params: inlineParams,
    });
    const first = (await backgroundLogger.drain()) as Record<string, any>[];

    const secondContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params: inlineParams,
    });
    const second = (await backgroundLogger.drain()) as Record<string, any>[];

    expect(secondContext).toBe(firstContext);
    expect(second.map((span) => span.id).sort()).toEqual(
      first.map((span) => span.id).sort(),
    );
  });

  test("reuses deterministic attachment references across collection retries", async () => {
    const params = {
      model,
      src: [
        {
          contents: {
            parts: [
              {
                inlineData: { data: "BAUG", mimeType: "image/png" },
              },
            ],
            role: "user",
          },
        },
      ],
    };
    const created = {
      model,
      name: "batches/attachment-retry-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params,
    });
    const started = (await backgroundLogger.drain()) as Record<string, any>[];
    const inputKey = started.find(
      (span) => span.span_attributes.name === "generate_content",
    )?.input.contents.parts[0].image_url.url.reference.key;
    await startGeminiDeveloperBatchTrace({ batch: created, params });
    const repeated = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(
      repeated.find((span) => span.span_attributes.name === "generate_content")
        ?.input.contents.parts[0].image_url.url.reference.key,
    ).toBe(inputKey);
    const completed = {
      ...created,
      dest: {
        inlinedResponses: [
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          data: "AQID",
                          mimeType: "image/png",
                        },
                      },
                    ],
                    role: "model",
                  },
                },
              ],
            },
          },
        ],
      },
      state: "JOB_STATE_SUCCEEDED",
    };

    const collect = async () => {
      await completeGeminiDeveloperBatchTrace({
        batch: completed,
        params,
        traceContext,
      });
      const rows = (await backgroundLogger.drain()) as Record<string, any>[];
      const child = rows.find(
        (span) => span.span_attributes.name === "generate_content",
      );
      return child?.output.candidates[0].content.parts[0].image_url.url
        .reference.key;
    };

    const firstKey = await collect();
    const retryKey = await collect();
    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(retryKey).toBe(firstKey);
  });

  test("correlates streamed file results by key instead of output order", async () => {
    const params = { model, src: "files/input-1" as const };
    const input = [
      JSON.stringify({
        key: "alpha",
        request: { contents: [{ parts: [{ text: "A" }], role: "user" }] },
      }),
      JSON.stringify({
        key: "beta",
        request: { contents: [{ parts: [{ text: "B" }], role: "user" }] },
      }),
    ].join("\n");
    const created = {
      createTime: "2026-08-19T11:00:00.000Z",
      model,
      name: "batches/file-1",
      state: "JOB_STATE_RUNNING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      input,
      params,
    });
    const started = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(
      started
        .filter((span) => span.span_attributes.name === "generate_content")
        .map((span) => span.metadata.batch_key)
        .sort(),
    ).toEqual(["alpha", "beta"]);

    const encoder = new TextEncoder();
    const outputFile = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                key: "beta",
                response: {
                  candidates: [{ content: { parts: [{ text: "B!" }] } }],
                  usageMetadata: { totalTokenCount: 7 },
                },
              })}\n${JSON.stringify({
                key: "alpha",
                response: {
                  candidates: [{ content: { parts: [{ text: "A!" }] } }],
                  usageMetadata: { totalTokenCount: 5 },
                },
              })}`,
            ),
          );
          controller.close();
        },
      }),
    );
    const completed = {
      ...created,
      dest: { fileName: "files/output-1" as const },
      endTime: "2026-08-19T11:01:00.000Z",
      state: "JOB_STATE_SUCCEEDED",
    };
    await completeGeminiDeveloperBatchTrace({
      batch: completed,
      input,
      outputFile,
      params,
      traceContext,
    });

    const completionRows = (await backgroundLogger.drain()) as Record<
      string,
      any
    >[];
    expect(completionRows).toHaveLength(3);
    expect(completionRows.map((span) => span.id).sort()).toEqual(
      started.map((span) => span.id).sort(),
    );
    expect(
      completionRows
        .filter((span) => span.span_attributes.name === "generate_content")
        .map((span) => span.output.candidates[0].content.parts[0].text)
        .sort(),
    ).toEqual(["A!", "B!"]);
  });

  test("prefers the provider-resolved batch model", async () => {
    const providerModel = "models/gemini-2.5-flash-001";
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: {
        model: providerModel,
        name: "batches/resolved-model-1",
        state: "JOB_STATE_PENDING",
      },
      params: {
        model: "models/gemini-2.5-flash",
        src: [{ contents: "Use the resolved model" }],
      },
    });

    expect(traceContext).toEqual(expect.any(String));
    const started = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(
      started.find((span) => span.span_attributes.name === "google-genai.batch")
        ?.metadata.model,
    ).toBe(providerModel);
    const child = started.find(
      (span) => span.span_attributes.name === "generate_content",
    );
    expect(child?.metadata.model).toBe(providerModel);
    expect(child?.input.model).toBe(providerModel);
  });

  test("preserves a request-specific model when completion has no resolved model", async () => {
    const requestModel = "models/gemini-2.5-pro";
    const params = {
      model,
      src: [{ contents: "Use the request model", model: requestModel }],
    };
    const created = {
      model,
      name: "batches/request-model-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params,
    });
    const started = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(
      started.find((span) => span.span_attributes.name === "generate_content")
        ?.metadata.model,
    ).toBe(requestModel);

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: {
          inlinedResponses: [
            {
              response: {
                candidates: [{ content: { parts: [{ text: "Done" }] } }],
              },
            },
          ],
        },
        state: "JOB_STATE_SUCCEEDED",
      },
      params,
      traceContext,
    });
    const completed = (await backgroundLogger.drain()) as Record<string, any>[];
    const child = completed.find(
      (span) => span.span_attributes.name === "generate_content",
    );
    expect(child?.metadata).toEqual({ provider: "google" });
    expect(child).not.toHaveProperty("error");
    const writes = [...started, ...completed].map((row) =>
      structuredClone(row),
    ) as Array<Record<string, any> & { id: string }>;
    const mergedChild = mergeRowBatch(writes).find(
      (span) => span.span_attributes.name === "generate_content",
    );
    expect(mergedChild?.metadata).toMatchObject({
      model: requestModel,
      provider: "google",
    });
  });

  test("flushes input and result spans periodically by count", async () => {
    const params = {
      model,
      src: Array.from({ length: 101 }, (_, index) => ({
        contents: `Request ${index}`,
      })),
    };
    const created = {
      model,
      name: "batches/backpressure-1",
      state: "JOB_STATE_PENDING",
    };
    const flushSpy = vi.spyOn(backgroundLogger, "flush");
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params,
    });
    expect(flushSpy).toHaveBeenCalledTimes(2);
    expect(await backgroundLogger.drain()).toHaveLength(102);

    flushSpy.mockClear();
    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: {
          inlinedResponses: params.src.map((_, index) => ({
            response: {
              candidates: [
                { content: { parts: [{ text: `Response ${index}` }] } },
              ],
            },
          })),
        },
        state: "JOB_STATE_SUCCEEDED",
      },
      params,
      traceContext,
    });
    expect(flushSpy).toHaveBeenCalledTimes(2);
    expect(await backgroundLogger.drain()).toHaveLength(102);
  });

  test("ignores nonterminal completions and safely falls back to collect-only", async () => {
    const created = {
      createTime: "2026-08-19T12:00:00.000Z",
      model,
      name: "batches/tamper-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params: inlineParams,
    });
    const started = (await backgroundLogger.drain()) as Record<string, any>[];

    const nonterminal = await completeGeminiDeveloperBatchTrace({
      batch: { ...created, state: "JOB_STATE_RUNNING" },
      params: inlineParams,
      traceContext,
    });
    expect(nonterminal.batch.state).toBe("JOB_STATE_RUNNING");
    expect(nonterminal.traceContext).toBe(traceContext);
    expect(await backgroundLogger.drain()).toHaveLength(0);

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: {
          inlinedResponses: [
            {
              response: {
                candidates: [{ content: { parts: [{ text: "A" }] } }],
              },
            },
            {
              response: {
                candidates: [{ content: { parts: [{ text: "B" }] } }],
              },
            },
          ],
        },
        updateTime: "2026-08-19T12:01:00.000Z",
        state: "JOB_STATE_SUCCEEDED",
      },
      params: inlineParams,
      traceContext: `${traceContext}tampered`,
    });
    const collectOnly = (await backgroundLogger.drain()) as Record<
      string,
      any
    >[];
    expect(collectOnly).toHaveLength(3);
    expect(collectOnly.map((span) => span.id).sort()).toEqual(
      started.map((span) => span.id).sort(),
    );
    expect(
      collectOnly.find(
        (span) => span.span_attributes.name === "google-genai.batch",
      )?.metrics.end,
    ).toBe(Date.parse("2026-08-19T12:01:00.000Z") / 1000);

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: {
          inlinedResponses: [
            {
              response: {
                candidates: [{ content: { parts: [{ text: "A" }] } }],
              },
            },
            {
              response: {
                candidates: [{ content: { parts: [{ text: "B" }] } }],
              },
            },
          ],
        },
        state: "JOB_STATE_SUCCEEDED",
      },
      params: {
        ...inlineParams,
        src: [
          ...inlineParams.src.slice(0, 1),
          { contents: [{ parts: [{ text: "Changed" }], role: "user" }] },
        ],
      },
      traceContext,
    });
    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  test("returns collect-only context that stays idempotent across active parents", async () => {
    const completed = {
      createTime: "2026-08-19T13:00:00.000Z",
      dest: {
        inlinedResponses: [
          {
            response: { candidates: [{ content: { parts: [{ text: "A" }] } }] },
          },
          { error: { code: 400, message: "Invalid second request" } },
        ],
      },
      model,
      name: "batches/collect-only-1",
      state: "JOB_STATE_SUCCEEDED",
      updateTime: "2026-08-19T13:02:00.000Z",
    };

    const firstParent = startSpan({ name: "collect-only-parent-a" });
    const firstResult = await withCurrent(firstParent, () =>
      completeGeminiDeveloperBatchTrace({
        batch: completed,
        params: inlineParams,
      }),
    );
    firstParent.end();
    expect(firstResult.batch).toBe(completed);
    expect(firstResult.traceContext).toEqual(expect.any(String));
    const first = (
      (await backgroundLogger.drain()) as Record<string, any>[]
    ).filter((span) =>
      ["generate_content", "google-genai.batch"].includes(
        span.span_attributes.name,
      ),
    );
    expect(first).toHaveLength(3);
    expect(
      first
        .filter((span) => span.span_attributes.name === "generate_content")
        .every((span) => span.input !== undefined),
    ).toBe(true);

    const retryParent = startSpan({ name: "collect-only-parent-b" });
    const retryResult = await withCurrent(retryParent, () =>
      completeGeminiDeveloperBatchTrace({
        batch: completed,
        params: inlineParams,
        traceContext: firstResult.traceContext,
      }),
    );
    retryParent.end();
    expect(retryResult).toEqual({
      batch: completed,
      traceContext: firstResult.traceContext,
    });
    const retry = (
      (await backgroundLogger.drain()) as Record<string, any>[]
    ).filter((span) =>
      ["generate_content", "google-genai.batch"].includes(
        span.span_attributes.name,
      ),
    );
    expect(retry.map((span) => span.id).sort()).toEqual(
      first.map((span) => span.id).sort(),
    );
  });

  test("binds collect-only identities to the supplied input", async () => {
    const completed = {
      dest: {
        inlinedResponses: [
          {
            response: { candidates: [{ content: { parts: [{ text: "A" }] } }] },
          },
        ],
      },
      model,
      name: "batches/collect-only-input-bound-1",
      state: "JOB_STATE_SUCCEEDED",
    };
    const parent = startSpan({ name: "collect-only-input-parent" });
    const firstResult = await withCurrent(parent, () =>
      completeGeminiDeveloperBatchTrace({
        batch: completed,
        params: { model, src: [{ contents: "First input" }] },
      }),
    );
    const first = (await backgroundLogger.drain()) as Record<string, any>[];
    const secondResult = await withCurrent(parent, () =>
      completeGeminiDeveloperBatchTrace({
        batch: completed,
        params: { model, src: [{ contents: "Different input" }] },
      }),
    );
    parent.end();
    const second = (await backgroundLogger.drain()) as Record<string, any>[];

    expect(secondResult.traceContext).not.toBe(firstResult.traceContext);
    expect(second.map((span) => span.id).sort()).not.toEqual(
      first.map((span) => span.id).sort(),
    );
  });

  test("completes file input larger than the former spool ceiling", async () => {
    const params = { model, src: "files/large-input" as const };
    const contents = "x".repeat(16 * 1024 * 1024 + 1);
    const input = JSON.stringify({
      key: "large",
      request: { contents },
    });

    const flushSpy = vi.spyOn(backgroundLogger, "flush");
    await completeGeminiDeveloperBatchTrace({
      batch: {
        createTime: "2026-08-19T14:00:00.000Z",
        dest: { fileName: "files/large-output" },
        model,
        name: "batches/large-1",
        state: "JOB_STATE_SUCCEEDED",
        updateTime: "2026-08-19T14:01:00.000Z",
      },
      input,
      outputFile: JSON.stringify({
        key: "large",
        response: { candidates: [{ content: { parts: [{ text: "Done" }] } }] },
      }),
      params,
    });

    const completed = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(flushSpy).toHaveBeenCalledTimes(2);
    expect(completed).toHaveLength(2);
    expect(
      completed.find((span) => span.span_attributes.name === "generate_content")
        ?.input.contents.text,
    ).toHaveLength(contents.length);
  });

  test("ends missing children when the provider batch fails", async () => {
    const created = {
      model,
      name: "batches/failed-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params: inlineParams,
    });
    const started = (await backgroundLogger.drain()) as Record<string, any>[];

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        error: { code: 500, message: "Batch service failed" },
        state: "JOB_STATE_FAILED",
      },
      params: inlineParams,
      traceContext,
    });
    const completed = (await backgroundLogger.drain()) as Record<string, any>[];

    expect(completed).toHaveLength(3);
    expect(completed.map((span) => span.id).sort()).toEqual(
      started.map((span) => span.id).sort(),
    );
    expect(
      completed.every((span) => span.error === "Batch service failed"),
    ).toBe(true);
  });

  test("keeps a successful batch pending until every result is usable", async () => {
    const params = {
      model,
      src: [{ contents: "Retry me" }],
    };
    const created = {
      model,
      name: "batches/malformed-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      params,
    });
    const started = (await backgroundLogger.drain()) as Record<string, any>[];

    for (const malformed of [
      {},
      { error: { message: "conflict" }, response: {} },
      {
        response: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("unreadable response");
            },
          },
        ),
      },
    ]) {
      await completeGeminiDeveloperBatchTrace({
        batch: {
          ...created,
          dest: { inlinedResponses: [malformed] },
          state: "JOB_STATE_SUCCEEDED",
        },
        params,
        traceContext,
      });
      const pending = (await backgroundLogger.drain()) as Record<string, any>[];
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: started.find(
          (span) => span.span_attributes.name === "google-genai.batch",
        )?.id,
        span_attributes: { name: "google-genai.batch", type: "task" },
      });
      expect(pending[0]?.metrics).not.toHaveProperty("end");
      expect(pending[0]).not.toHaveProperty("error");
    }

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: {
          inlinedResponses: [
            {
              response: {
                candidates: [{ content: { parts: [{ text: "Recovered" }] } }],
              },
            },
          ],
        },
        state: "JOB_STATE_SUCCEEDED",
      },
      params,
      traceContext,
    });
    const completed = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(completed).toHaveLength(2);
    expect(completed.map((span) => span.id).sort()).toEqual(
      started.map((span) => span.id).sort(),
    );
  });

  test("keeps successful batches pending until result correlation is exact", async () => {
    const params = { model, src: "files/extraneous-input" as const };
    const input = JSON.stringify({
      key: "expected",
      request: { contents: "Correlate me" },
    });
    const created = {
      model,
      name: "batches/extraneous-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      input,
      params,
    });
    await backgroundLogger.drain();
    const expected = {
      key: "expected",
      response: {
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
      },
    };

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: { fileName: "files/extraneous-output" as const },
        state: "JOB_STATE_SUCCEEDED",
      },
      input,
      outputFile: [
        JSON.stringify(expected),
        JSON.stringify(expected),
        JSON.stringify({
          key: "unknown",
          response: {
            candidates: [{ content: { parts: [{ text: "Ignore" }] } }],
          },
        }),
        JSON.stringify({ key: "expected" }),
        "{trailing malformed json",
      ].join("\n"),
      params,
      traceContext,
    });

    const pending = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(pending).toHaveLength(2);
    expect(
      pending.find((span) => span.span_attributes.name === "google-genai.batch")
        ?.metrics,
    ).not.toHaveProperty("end");

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: { fileName: "files/extraneous-output" as const },
        state: "JOB_STATE_SUCCEEDED",
      },
      input,
      outputFile: JSON.stringify(expected),
      params,
      traceContext,
    });
    const completed = (await backgroundLogger.drain()) as Record<string, any>[];
    expect(
      completed.find(
        (span) => span.span_attributes.name === "google-genai.batch",
      )?.metrics.end,
    ).toEqual(expect.any(Number));
  });

  test("clears an error after a conflict and a successful retry", async () => {
    const params = { model, src: "files/ambiguous-input" as const };
    const input = JSON.stringify({
      key: "expected",
      request: { contents: "Correlate me once" },
    });
    const created = {
      model,
      name: "batches/ambiguous-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      input,
      params,
    });
    const started = (await backgroundLogger.drain()) as Record<string, any>[];

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: { fileName: "files/ambiguous-output" as const },
        state: "JOB_STATE_SUCCEEDED",
      },
      input,
      outputFile: [
        JSON.stringify({
          error: { message: "First failed" },
          key: "expected",
        }),
        JSON.stringify({
          key: "expected",
          response: {
            candidates: [{ content: { parts: [{ text: "Conflicting" }] } }],
          },
        }),
      ].join("\n"),
      params,
      traceContext,
    });

    const pending = (await backgroundLogger.drain()) as Record<string, any>[];
    const task = pending.find(
      (span) => span.span_attributes.name === "google-genai.batch",
    );
    expect(task?.id).toBe(
      started.find((span) => span.span_attributes.name === "google-genai.batch")
        ?.id,
    );
    expect(task?.metrics).not.toHaveProperty("end");
    const pendingChild = pending.find(
      (span) => span.span_attributes.name === "generate_content",
    );
    expect(pendingChild?.error).toBeNull();
    expect(pendingChild?.output).toBeNull();
    expect(pendingChild?.metrics).toEqual({
      start: expect.any(Number),
    });

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: { fileName: "files/ambiguous-output" },
        state: "JOB_STATE_SUCCEEDED",
      },
      input,
      outputFile: JSON.stringify({
        key: "expected",
        response: {
          candidates: [{ content: { parts: [{ text: "Recovered" }] } }],
          usageMetadata: { totalTokenCount: 7 },
        },
      }),
      params,
      traceContext,
    });

    const completed = (await backgroundLogger.drain()) as Record<string, any>[];
    const completedTask = completed.find(
      (span) => span.span_attributes.name === "google-genai.batch",
    );
    const completedChild = completed.find(
      (span) => span.span_attributes.name === "generate_content",
    );
    expect(completedTask?.metrics.end).toEqual(expect.any(Number));
    expect(completedChild).not.toHaveProperty("error");
    expect(completedChild?.output).toMatchObject({
      candidates: [{ content: { parts: [{ text: "Recovered" }] } }],
    });
    expect(completedChild?.metrics.tokens).toBe(7);

    const writes = [...started, ...pending, ...completed].map((row) =>
      structuredClone(row),
    ) as Array<Record<string, any> & { id: string }>;
    const merged = mergeRowBatch(writes);
    const mergedChild = merged.find(
      (span) => span.span_attributes.name === "generate_content",
    );
    expect(mergedChild?.error).toBeNull();
    expect(mergedChild?.output).toMatchObject({
      candidates: [{ content: { parts: [{ text: "Recovered" }] } }],
    });
    expect(mergedChild?.metrics.tokens).toBe(7);
  });

  test("ends ambiguous children when the provider batch fails", async () => {
    const params = { model, src: "files/failed-ambiguous-input" };
    const input = JSON.stringify({
      key: "expected",
      request: { contents: "This batch fails" },
    });
    const created = {
      model,
      name: "batches/failed-ambiguous-1",
      state: "JOB_STATE_PENDING",
    };
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: created,
      input,
      params,
    });
    await backgroundLogger.drain();

    await completeGeminiDeveloperBatchTrace({
      batch: {
        ...created,
        dest: { fileName: "files/failed-ambiguous-output" },
        error: { message: "Provider batch failed" },
        state: "JOB_STATE_FAILED",
      },
      input,
      outputFile: [
        JSON.stringify({
          key: "expected",
          response: {
            candidates: [{ content: { parts: [{ text: "First" }] } }],
          },
        }),
        JSON.stringify({
          error: { message: "Conflicting request error" },
          key: "expected",
        }),
      ].join("\n"),
      params,
      traceContext,
    });

    const completed = (await backgroundLogger.drain()) as Record<string, any>[];
    const child = completed.find(
      (span) => span.span_attributes.name === "generate_content",
    );
    expect(child?.error).toBe("Provider batch failed");
    expect(child?.metrics.end).toEqual(expect.any(Number));
  });

  test("handles rejected file input immediately on inline start paths", async () => {
    const input = Promise.reject(new Error("unused file input failed"));
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: { model, name: "batches/rejected-input-1" },
      input,
      params: inlineParams,
    });

    expect(traceContext).toEqual(expect.any(String));
    expect(await backgroundLogger.drain()).toHaveLength(3);
  });

  test("does not consume caller-owned Response inputs", async () => {
    const input = new Response(
      JSON.stringify({
        key: "response-input",
        request: { contents: "Do not consume me" },
      }),
    );
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: { model, name: "batches/response-input-1" },
      input,
      params: { model, src: "files/response-input" },
    });

    expect(traceContext).toBeUndefined();
    expect(input.bodyUsed).toBe(false);
    expect(await input.text()).toContain("Do not consume me");
    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  test("returns undefined without spans for Vertex-style sources", async () => {
    const traceContext = await startGeminiDeveloperBatchTrace({
      batch: { model, name: "projects/p/locations/l/batchPredictionJobs/1" },
      params: {
        model,
        src: "gs://bucket/input.jsonl",
      },
    });

    expect(traceContext).toBeUndefined();
    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  test("serializes cyclic arrays and __proto__ keys safely", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(serializeGoogleGenAIValue(cyclic)).toEqual(["[Circular]"]);
    expect(serializeGoogleGenAIContents(cyclic)).toEqual(["[Circular]"]);

    const value = {};
    Object.defineProperty(value, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const serialized = serializeGoogleGenAIValue(value) as Record<
      string,
      unknown
    >;
    expect(Object.prototype.hasOwnProperty.call(serialized, "__proto__")).toBe(
      true,
    );
    expect(serialized.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(serialized)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test("redacts built-in tool credentials and normalizes tool choice", () => {
    expect(
      serializeGoogleGenAITools([
        {
          parallelAiSearch: {
            apiKey: "parallel-secret",
            customConfigs: {
              excerpts: {
                authorization: "excerpt-secret",
                max_chars_per_result: 2_000,
                max_chars_total: 8_000,
              },
              fetch_policy: {
                authorization: "fetch-secret",
                max_age_seconds: 60,
              },
              headers: { Authorization: "parallel-header-secret" },
              max_results: 3,
              mode: "fast",
              source_policy: {
                authorization: "source-secret",
                include_domains: ["example.com"],
              },
            },
          },
        },
        {
          mcpServers: [
            {
              name: "safe-server-name",
              streamableHttpTransport: {
                headers: { Authorization: "mcp-header-secret" },
                sseReadTimeout: "20s",
                terminateOnClose: true,
                timeout: "10s",
                url: "https://user:password@example.com/mcp?token=secret",
              },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        config: {
          customConfigs: {
            excerpts: {
              max_chars_per_result: 2_000,
              max_chars_total: 8_000,
            },
            fetch_policy: { max_age_seconds: 60 },
            max_results: 3,
            mode: "fast",
            source_policy: { include_domains: ["example.com"] },
          },
        },
        type: "parallelAiSearch",
      },
      {
        config: {
          servers: [
            {
              name: "safe-server-name",
              streamableHttpTransport: {
                sseReadTimeout: "20s",
                terminateOnClose: true,
                timeout: "10s",
                url: "https://example.com/mcp",
              },
            },
          ],
        },
        type: "mcpServers",
      },
    ]);

    expect(
      normalizeGoogleGenAIToolChoice({
        functionCallingConfig: {
          allowedFunctionNames: ["get_weather"],
          mode: "ANY",
        },
      }),
    ).toEqual({ function: { name: "get_weather" }, type: "function" });
    expect(
      normalizeGoogleGenAIToolChoice({
        functionCallingConfig: { mode: "NONE" },
      }),
    ).toBe("none");
    expect(
      normalizeGoogleGenAIToolChoice({
        functionCallingConfig: { mode: "AUTO" },
      }),
    ).toBe("auto");
    expect(
      normalizeGoogleGenAIToolChoice({
        functionCallingConfig: {
          allowedFunctionNames: ["first", "second"],
          mode: "ANY",
        },
      }),
    ).toBe("required");
  });

  test("normalizes Google function schemas but preserves JSON Schema", () => {
    expect(
      serializeGoogleGenAITools([
        {
          functionDeclarations: [
            {
              name: "google_schema",
              parameters: {
                anyOf: [{ type: "STRING" }, { type: "NUMBER" }],
                example: { type: "OBJECT" },
                properties: {
                  count: { type: "INTEGER" },
                  nested: {
                    items: { type: "BOOLEAN" },
                    type: "ARRAY",
                  },
                },
                type: "OBJECT",
              },
            },
            {
              name: "json_schema",
              parametersJsonSchema: {
                properties: { value: { type: "STRING" } },
                type: "OBJECT",
              },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        function: {
          name: "google_schema",
          parameters: {
            anyOf: [{ type: "string" }, { type: "number" }],
            example: { type: "OBJECT" },
            properties: {
              count: { type: "integer" },
              nested: { items: { type: "boolean" }, type: "array" },
            },
            type: "object",
          },
        },
        type: "function",
      },
      {
        function: {
          name: "json_schema",
          parameters: {
            properties: { value: { type: "STRING" } },
            type: "OBJECT",
          },
        },
        type: "function",
      },
    ]);
  });

  test("preserves allowlisted built-in tool behavior without credentials", () => {
    const tools = serializeGoogleGenAITools([
      {
        computerUse: {
          enablePromptInjectionDetection: true,
          environment: "ENVIRONMENT_BROWSER",
        },
      },
      {
        retrieval: {
          externalApi: {
            apiSpec: "SIMPLE_SEARCH",
            authConfig: { apiKeyConfig: { apiKeyString: "external-secret" } },
            endpoint: "https://user:pass@search.example.com/query?token=secret",
          },
          vertexAiSearch: {
            dataStoreSpecs: [
              { dataStore: "projects/p/dataStores/docs", filter: "public" },
            ],
            maxResults: 4,
          },
          vertexRagStore: {
            ragResources: [
              { ragCorpus: "projects/p/ragCorpora/c", ragFileIds: ["file-1"] },
            ],
            ragRetrievalConfig: {
              filter: { vectorSimilarityThreshold: 0.8 },
              topK: 3,
            },
          },
        },
      },
    ]);

    expect(tools).toEqual([
      {
        config: {
          enablePromptInjectionDetection: true,
          environment: "ENVIRONMENT_BROWSER",
        },
        type: "computerUse",
      },
      {
        config: {
          externalApi: {
            apiSpec: "SIMPLE_SEARCH",
            endpoint: "https://search.example.com/query",
          },
          vertexAiSearch: {
            dataStoreSpecs: [
              { dataStore: "projects/p/dataStores/docs", filter: "public" },
            ],
            maxResults: 4,
          },
          vertexRagStore: {
            ragResources: [
              { ragCorpus: "projects/p/ragCorpora/c", ragFileIds: ["file-1"] },
            ],
            ragRetrievalConfig: {
              filter: { vectorSimilarityThreshold: 0.8 },
              topK: 3,
            },
          },
        },
        type: "retrieval",
      },
    ]);
    expect(JSON.stringify(tools)).not.toContain("external-secret");
    expect(JSON.stringify(tools)).not.toContain("token=secret");
  });
});
