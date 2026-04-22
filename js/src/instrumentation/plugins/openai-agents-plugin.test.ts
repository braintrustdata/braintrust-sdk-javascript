import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureNode } from "../../node/config";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { openAIAgentsCoreChannels } from "./openai-agents-channels";
import { OpenAIAgentsPlugin } from "./openai-agents-plugin";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

describe("OpenAIAgentsPlugin", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;
  let plugin: OpenAIAgentsPlugin;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "openai-agents-plugin.test.ts",
      projectId: "test-project-id",
    });
    plugin = new OpenAIAgentsPlugin();
    plugin.enable();
  });

  afterEach(() => {
    plugin.disable();
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

    await openAIAgentsCoreChannels.onTraceStart.tracePromise(
      async () => undefined,
      { arguments: [trace] },
    );
    await openAIAgentsCoreChannels.onSpanStart.tracePromise(
      async () => undefined,
      { arguments: [span] },
    );
    await openAIAgentsCoreChannels.onSpanEnd.tracePromise(
      async () => undefined,
      { arguments: [span] },
    );
    await openAIAgentsCoreChannels.onTraceEnd.tracePromise(
      async () => undefined,
      { arguments: [trace] },
    );

    const spans = await backgroundLogger.drain();
    const taskSpan = spans.find(
      (s) => s.span_attributes?.name === "Agent workflow",
    );
    const generationSpan = spans.find(
      (s) => s.span_attributes?.name === "Generation",
    );

    expect(taskSpan?.span_attributes?.type).toBe("task");
    expect(generationSpan?.span_attributes?.type).toBe("llm");
    expect(generationSpan?.metrics).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 1,
      tokens: 6,
    });
  });
});
