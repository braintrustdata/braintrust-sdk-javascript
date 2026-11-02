import { configureInstrumentation } from "../registry";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { _exportsForTestingOnly } from "../../logger/testing";
import { initLogger } from "../../logger/core";
import { configureNode } from "../../node/config";
import { openAIAgentsCoreChannels } from "./openai-agents-interceptors";
import { registerOpenAIAgentsInstrumentation } from "./openai-agents-instrumentation";

try {
  configureInstrumentation({ integrations: { openAIAgents: false } });
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("registerOpenAIAgentsInstrumentation", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
    registerOpenAIAgentsInstrumentation();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openai-agents-instrumentation.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("records Braintrust spans from OpenAI Agents trace processor lifecycle events", async () => {
    const trace = {
      type: "trace",
      traceId: "trace-openai-agents-auto",
      name: "Agent workflow",
      groupId: "group-openai-agents-auto",
      metadata: { workflow: "test" },
    };
    const startedAt = new Date(Date.now() - 100).toISOString();
    const endedAt = new Date().toISOString();
    const span = {
      type: "trace.span",
      traceId: trace.traceId,
      spanId: "span-generation",
      parentId: null,
      startedAt,
      endedAt,
      error: null,
      spanData: {
        type: "generation",
        input: [{ role: "user", content: "What is 2+2?" }],
        output: [{ role: "assistant", content: "4" }],
        model: "gpt-4.1-mini",
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6,
        },
      },
    };

    await openAIAgentsCoreChannels.onTraceStart.invoke(
      async () => undefined,
      undefined,
      [trace as any],
      {},
    );
    await openAIAgentsCoreChannels.onSpanStart.invoke(
      async () => undefined,
      undefined,
      [span as any],
      {},
    );
    await openAIAgentsCoreChannels.onSpanEnd.invoke(
      async () => undefined,
      undefined,
      [span as any],
      {},
    );
    await openAIAgentsCoreChannels.onTraceEnd.invoke(
      async () => undefined,
      undefined,
      [trace as any],
      {},
    );

    const spans = (await backgroundLogger.drain()) as any[];
    const taskSpan = spans.find(
      (s) => s.span_attributes?.name === "Agent workflow",
    );
    const generationSpan = spans.find(
      (s) => s.span_attributes?.name === "Generation",
    );

    expect(taskSpan?.span_attributes?.type).toBe("task");
    expect(generationSpan?.span_attributes?.type).toBe("llm");
    for (const instrumentedSpan of [taskSpan, generationSpan]) {
      expect(instrumentedSpan?.context?.span_origin).toMatchObject({
        instrumentation: { name: "openai-agents" },
      });
    }
    expect(generationSpan?.metrics).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 1,
      tokens: 6,
    });
  });
});
