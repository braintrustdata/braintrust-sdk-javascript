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
