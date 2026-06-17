import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _exportsForTestingOnly, currentSpan, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { braintrustAISDKTelemetry } from "../../wrappers/ai-sdk/telemetry";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("braintrustAISDKTelemetry", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "ai-sdk-v7-telemetry.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("logs a generateText operation and model call", async () => {
    const telemetry = braintrustAISDKTelemetry();

    telemetry.onStart?.({
      callId: "call-1",
      operationId: "ai.generateText",
      provider: "openai",
      modelId: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Reply with OK." }],
      temperature: 0,
    });
    telemetry.onLanguageModelCallStart?.({
      callId: "call-1",
      provider: "openai",
      modelId: "gpt-4.1-mini",
      prompt: [{ role: "user", content: "Reply with OK." }],
    });
    telemetry.onLanguageModelCallEnd?.({
      callId: "call-1",
      provider: "openai",
      modelId: "gpt-4.1-mini",
      text: "OK",
      usage: {
        inputTokens: 6,
        outputTokens: 1,
        totalTokens: 7,
      },
    });
    telemetry.onFinish?.({
      callId: "call-1",
      operationId: "ai.generateText",
      text: "OK",
      usage: {
        inputTokens: 6,
        outputTokens: 1,
        totalTokens: 7,
      },
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const operation = spans.find(
      (span) => span.span_attributes?.name === "generateText",
    );
    const modelCall = spans.find(
      (span) => span.span_attributes?.name === "doGenerate",
    );

    expect(operation).toMatchObject({
      span_attributes: {
        type: "function",
        name: "generateText",
      },
      input: {
        messages: [{ role: "user", content: "Reply with OK." }],
      },
      metadata: {
        provider: "openai",
        model: "gpt-4.1-mini",
      },
    });
    expect(operation?.output).toMatchObject({ text: "OK" });

    expect(modelCall).toMatchObject({
      span_attributes: {
        type: "llm",
        name: "doGenerate",
      },
      metrics: {
        prompt_tokens: 6,
        completion_tokens: 1,
        tokens: 7,
      },
      metadata: {
        provider: "openai",
        model: "gpt-4.1-mini",
      },
    });
    expect(modelCall?.output).toMatchObject({ text: "OK" });
  });

  it("honors recordInputs and recordOutputs", async () => {
    const telemetry = braintrustAISDKTelemetry();

    telemetry.onStart?.({
      callId: "call-2",
      operationId: "ai.generateText",
      recordInputs: false,
      messages: [{ role: "user", content: "hidden" }],
    });
    telemetry.onFinish?.({
      callId: "call-2",
      operationId: "ai.generateText",
      recordOutputs: false,
      text: "hidden",
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const operation = spans.find(
      (span) => span.span_attributes?.name === "generateText",
    );

    expect(operation).toBeDefined();
    expect(operation).not.toHaveProperty("input");
    expect(operation).not.toHaveProperty("output");
  });

  it("ends open child spans when an operation errors", async () => {
    const telemetry = braintrustAISDKTelemetry();
    const callId = "call-error";
    const error = new Error("provider exploded");

    telemetry.onStart?.({
      callId,
      operationId: "ai.streamText",
    });
    telemetry.onLanguageModelCallStart?.({
      callId,
      provider: "openai",
      modelId: "gpt-4.1-mini",
      prompt: [{ role: "user", content: "Reply with OK." }],
    });
    telemetry.onObjectStepStart?.({
      callId,
      provider: "openai",
      modelId: "gpt-4.1-mini",
      promptMessages: [{ role: "user", content: "Return an object." }],
    });
    telemetry.onEmbedStart?.({
      callId,
      embedCallId: "embed-error",
      operationId: "ai.embed",
      provider: "openai",
      modelId: "text-embedding-3-small",
      values: ["hello"],
    });
    telemetry.onRerankStart?.({
      callId,
      provider: "cohere",
      modelId: "rerank-v3.5",
      documents: ["alpha", "beta"],
      query: "alpha",
      topN: 1,
    });
    telemetry.onToolExecutionStart?.({
      callId,
      toolCall: {
        toolCallId: "tool-error",
        toolName: "lookupWeather",
        input: { city: "Vienna" },
      },
    });

    telemetry.onError?.({ callId, error });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const errorSpans = spans.filter((span) =>
      String(span.error).includes("provider exploded"),
    );

    expect(errorSpans).toHaveLength(6);
    expect(errorSpans.map((span) => span.span_attributes?.name)).toEqual(
      expect.arrayContaining([
        "streamText",
        "doStream",
        "doGenerate",
        "doEmbed",
        "doRerank",
        "lookupWeather",
      ]),
    );

    telemetry.onLanguageModelCallEnd?.({ callId, text: "late" });
    telemetry.onObjectStepFinish?.({ callId, objectText: "{}" });
    telemetry.onEmbedFinish?.({
      callId,
      embedCallId: "embed-error",
      operationId: "ai.embed",
      embeddings: [[0.1]],
    });
    telemetry.onRerankFinish?.({
      callId,
      ranking: [{ index: 0, relevanceScore: 1 }],
    });
    telemetry.onToolExecutionEnd?.({
      callId,
      toolCall: { toolCallId: "tool-error", toolName: "lookupWeather" },
      toolOutput: { type: "tool-result", output: "late" },
    });
    telemetry.onFinish?.({
      callId,
      operationId: "ai.streamText",
      text: "late",
    });

    expect(await backgroundLogger.drain()).toHaveLength(0);
  });

  it("ends superseded retry child spans before successful finish", async () => {
    const telemetry = braintrustAISDKTelemetry();

    telemetry.onStart?.({
      callId: "stream-retry",
      operationId: "ai.streamText",
    });
    telemetry.onLanguageModelCallStart?.({
      callId: "stream-retry",
      messages: [{ role: "user", content: "first stream attempt" }],
    });
    telemetry.onLanguageModelCallStart?.({
      callId: "stream-retry",
      messages: [{ role: "user", content: "retry stream attempt" }],
    });
    telemetry.onLanguageModelCallEnd?.({
      callId: "stream-retry",
      text: "OK",
    });
    telemetry.onFinish?.({
      callId: "stream-retry",
      operationId: "ai.streamText",
      text: "OK",
    });

    telemetry.onStart?.({
      callId: "embed-retry",
      operationId: "ai.embed",
    });
    telemetry.onEmbedStart?.({
      callId: "embed-retry",
      embedCallId: "embed-attempt-1",
      operationId: "ai.embed.doEmbed",
      values: ["first embed attempt"],
    });
    telemetry.onEmbedStart?.({
      callId: "embed-retry",
      embedCallId: "embed-attempt-2",
      operationId: "ai.embed.doEmbed",
      values: ["retry embed attempt"],
    });
    telemetry.onEmbedFinish?.({
      callId: "embed-retry",
      embedCallId: "embed-attempt-2",
      operationId: "ai.embed.doEmbed",
      embeddings: [[0.1]],
    });
    telemetry.onFinish?.({
      callId: "embed-retry",
      operationId: "ai.embed",
      embedding: [0.1],
    });

    telemetry.onStart?.({
      callId: "rerank-retry",
      operationId: "ai.rerank",
    });
    telemetry.onRerankStart?.({
      callId: "rerank-retry",
      documents: ["first rerank attempt"],
      query: "first",
    });
    telemetry.onRerankStart?.({
      callId: "rerank-retry",
      documents: ["retry rerank attempt"],
      query: "retry",
    });
    telemetry.onRerankFinish?.({
      callId: "rerank-retry",
      ranking: [{ index: 0, relevanceScore: 1 }],
    });
    telemetry.onFinish?.({
      callId: "rerank-retry",
      operationId: "ai.rerank",
      ranking: [{ originalIndex: 0, score: 1 }],
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const streamSpans = spans.filter(
      (span) => span.span_attributes?.name === "doStream",
    );
    const embedSpans = spans.filter(
      (span) => span.span_attributes?.name === "doEmbed",
    );
    const rerankSpans = spans.filter(
      (span) => span.span_attributes?.name === "doRerank",
    );

    expect(streamSpans).toHaveLength(2);
    expect(
      streamSpans.find((span) =>
        JSON.stringify(span.input).includes("first stream attempt"),
      ),
    ).not.toHaveProperty("output");
    expect(
      streamSpans.find((span) =>
        JSON.stringify(span.input).includes("retry stream attempt"),
      )?.output,
    ).toMatchObject({ text: "OK" });

    expect(embedSpans).toHaveLength(2);
    expect(
      embedSpans.find((span) =>
        JSON.stringify(span.input).includes("first embed attempt"),
      ),
    ).not.toHaveProperty("output");
    expect(
      embedSpans.find((span) =>
        JSON.stringify(span.input).includes("retry embed attempt"),
      ),
    ).toHaveProperty("output");

    expect(rerankSpans).toHaveLength(2);
    expect(
      rerankSpans.find((span) =>
        JSON.stringify(span.input).includes("first rerank attempt"),
      ),
    ).not.toHaveProperty("output");
    expect(
      rerankSpans.find((span) =>
        JSON.stringify(span.input).includes("retry rerank attempt"),
      ),
    ).toHaveProperty("output");
  });

  it("runs tool execution under the tool span", async () => {
    const telemetry = braintrustAISDKTelemetry();

    telemetry.onStart?.({
      callId: "call-3",
      operationId: "ai.generateText",
    });
    telemetry.onToolExecutionStart?.({
      callId: "call-3",
      toolCall: {
        toolCallId: "tool-1",
        toolName: "lookupWeather",
        input: { city: "Vienna" },
      },
    });

    let activeToolSpanId: string | undefined;
    await telemetry.executeTool?.({
      callId: "call-3",
      toolCallId: "tool-1",
      execute: async () => {
        activeToolSpanId = currentSpan().spanId;
        return { temperature: 21 };
      },
    });

    telemetry.onToolExecutionEnd?.({
      callId: "call-3",
      durationMs: 12,
      toolCall: {
        toolCallId: "tool-1",
        toolName: "lookupWeather",
      },
      toolOutput: {
        type: "tool-result",
        output: { temperature: 21 },
      },
    });
    telemetry.onFinish?.({
      callId: "call-3",
      operationId: "ai.generateText",
      text: "It is 21 C.",
    });

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, any>
    >;
    const toolSpan = spans.find(
      (span) => span.span_attributes?.name === "lookupWeather",
    );

    expect(activeToolSpanId).toBe(toolSpan?.span_id);
    expect(toolSpan).toMatchObject({
      span_attributes: {
        type: "tool",
        name: "lookupWeather",
      },
      input: { city: "Vienna" },
      output: { temperature: 21 },
      metrics: { duration_ms: 12 },
    });
  });
});
