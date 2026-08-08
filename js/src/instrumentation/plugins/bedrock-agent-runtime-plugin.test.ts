import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { bedrockAgentSmithyCoreChannels } from "./bedrock-agent-runtime-channels";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

class InvokeAgentCommand {
  constructor(public input: Record<string, unknown>) {}
}

class RetrieveAndGenerateCommand {
  constructor(public input: Record<string, unknown>) {}
}

class RetrieveAndGenerateStreamCommand {
  constructor(public input: Record<string, unknown>) {}
}

class CreateSessionCommand {
  constructor(public input: Record<string, unknown>) {}
}

describe("BedrockAgentRuntimePlugin", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "bedrock-agent-runtime-plugin.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("captures an agent task with model and tool child spans", async () => {
    async function* completion() {
      yield {
        trace: {
          sessionId: "session-1",
          trace: {
            orchestrationTrace: {
              modelInvocationInput: {
                foundationModel: "amazon.nova-lite-v1:0",
                inferenceConfiguration: {
                  maximumLength: 32,
                  temperature: 0,
                },
                text: "model prompt",
                traceId: "model-1",
                type: "ORCHESTRATION",
              },
            },
          },
        },
      };
      yield {
        trace: {
          sessionId: "session-1",
          trace: {
            orchestrationTrace: {
              modelInvocationOutput: {
                metadata: {
                  usage: {
                    inputTokens: 10,
                    outputTokens: 4,
                  },
                },
                rawResponse: {
                  content: JSON.stringify({ action: "get_weather" }),
                },
                traceId: "model-1",
              },
            },
          },
        },
      };
      yield {
        trace: {
          sessionId: "session-1",
          trace: {
            orchestrationTrace: {
              invocationInput: {
                actionGroupInvocationInput: {
                  actionGroupName: "weather",
                  function: "get_weather",
                  parameters: [{ name: "city", value: "Paris" }],
                },
                traceId: "tool-1",
              },
            },
          },
        },
      };
      yield {
        trace: {
          sessionId: "session-1",
          trace: {
            orchestrationTrace: {
              observation: {
                actionGroupInvocationOutput: {
                  text: JSON.stringify({ temperature: 18 }),
                },
                traceId: "tool-1",
                type: "ACTION_GROUP",
              },
            },
          },
        },
      };
      yield {
        chunk: {
          bytes: new TextEncoder().encode("It is 18°C."),
        },
      };
    }

    const response =
      await bedrockAgentSmithyCoreChannels.clientSend.tracePromise(
        async () => ({
          completion: completion(),
          contentType: "application/json",
          sessionId: "session-1",
        }),
        {
          arguments: [
            new InvokeAgentCommand({
              agentAliasId: "alias-1",
              agentId: "agent-1",
              enableTrace: true,
              inputText: "What is the weather in Paris?",
              sessionId: "session-1",
            }) as any,
          ],
        },
      );

    for await (const _event of response.completion) {
      // Consume the response so the instrumented span can finish.
    }

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, unknown> & {
        span_attributes?: { name?: string; type?: string };
        span_id?: string;
        span_parents?: string[];
      }
    >;
    const parent = spans.find(
      (span) => span.span_attributes?.name === "bedrockAgent.invokeAgent",
    );
    const model = spans.find(
      (span) => span.span_attributes?.name === "bedrockAgent.modelInvocation",
    );
    const tool = spans.find(
      (span) => span.span_attributes?.name === "get_weather",
    );

    expect(parent).toMatchObject({
      input: "What is the weather in Paris?",
      metadata: {
        agentAliasId: "alias-1",
        agentId: "agent-1",
        command: "InvokeAgentCommand",
        operation: "invokeAgent",
        provider: "aws-bedrock",
        sessionId: "session-1",
      },
      metrics: {
        completion_tokens: 4,
        prompt_tokens: 10,
        time_to_first_token: expect.any(Number),
        tokens: 14,
      },
      output: {
        text: "It is 18°C.",
      },
      span_attributes: {
        name: "bedrockAgent.invokeAgent",
        type: "task",
      },
    });
    expect(model).toMatchObject({
      input: "model prompt",
      metadata: {
        maximumLength: 32,
        model: "amazon.nova-lite-v1:0",
        prompt_type: "ORCHESTRATION",
        provider: "aws-bedrock",
        temperature: 0,
      },
      metrics: {
        completion_tokens: 4,
        prompt_tokens: 10,
        tokens: 14,
      },
      output: {
        action: "get_weather",
      },
      span_attributes: {
        name: "bedrockAgent.modelInvocation",
        type: "llm",
      },
    });
    expect(tool).toMatchObject({
      input: {
        parameters: [{ name: "city", value: "Paris" }],
      },
      metadata: {
        action_group: "weather",
        provider: "aws-bedrock",
        tool_type: "action_group",
      },
      output: {
        text: JSON.stringify({ temperature: 18 }),
      },
      span_attributes: {
        name: "get_weather",
        type: "tool",
      },
    });
    expect(model?.span_parents).toEqual([parent?.span_id]);
    expect(tool?.span_parents).toEqual([parent?.span_id]);
  });

  it("captures non-streaming retrieve-and-generate responses", async () => {
    await bedrockAgentSmithyCoreChannels.clientSend.tracePromise(
      async () => ({
        citations: [{ generatedResponsePart: { text: "Paris" } }],
        guardrailAction: "NONE",
        output: { text: "Paris is in France." },
        sessionId: "rag-session",
      }),
      {
        arguments: [
          new RetrieveAndGenerateCommand({
            input: { text: "Where is Paris?" },
            retrieveAndGenerateConfiguration: {
              knowledgeBaseConfiguration: {
                knowledgeBaseId: "kb-1",
                modelArn: "arn:aws:bedrock:model/test",
              },
              type: "KNOWLEDGE_BASE",
            },
          }) as any,
        ],
      },
    );

    const spans = await backgroundLogger.drain();
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: { text: "Where is Paris?" },
          metadata: expect.objectContaining({
            knowledgeBaseId: "kb-1",
            model: "arn:aws:bedrock:model/test",
            operation: "retrieveAndGenerate",
          }),
          output: {
            citations: [{ generatedResponsePart: { text: "Paris" } }],
            text: "Paris is in France.",
          },
          span_attributes: expect.objectContaining({
            name: "bedrockAgent.retrieveAndGenerate",
            type: "task",
          }),
        }),
      ]),
    );
  });

  it("accumulates retrieve-and-generate stream output and citations", async () => {
    async function* stream() {
      yield { output: { text: "Paris " } };
      yield { output: { text: "is in France." } };
      yield {
        citation: {
          generatedResponsePart: { text: "Paris" },
        },
      };
    }

    const response =
      await bedrockAgentSmithyCoreChannels.clientSend.tracePromise(
        async () => ({
          sessionId: "rag-session",
          stream: stream(),
        }),
        {
          arguments: [
            new RetrieveAndGenerateStreamCommand({
              input: { text: "Where is Paris?" },
            }) as any,
          ],
        },
      );

    for await (const _event of response.stream) {
      // Consume the response so the instrumented span can finish.
    }

    const spans = await backgroundLogger.drain();
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            citations: [
              {
                generatedResponsePart: { text: "Paris" },
              },
            ],
            text: "Paris is in France.",
          },
          span_attributes: expect.objectContaining({
            name: "bedrockAgent.retrieveAndGenerateStream",
          }),
        }),
      ]),
    );
  });

  it("reports stream exceptions and closes open child spans", async () => {
    async function* completion() {
      yield {
        trace: {
          sessionId: "session-error",
          trace: {
            orchestrationTrace: {
              modelInvocationInput: {
                foundationModel: "amazon.nova-lite-v1:0",
                text: "model prompt",
                traceId: "model-error",
                type: "ORCHESTRATION",
              },
            },
          },
        },
      };
      yield {
        throttlingException: {
          message: "rate limited",
        },
      };
    }

    const response =
      await bedrockAgentSmithyCoreChannels.clientSend.tracePromise(
        async () => ({
          completion: completion(),
          sessionId: "session-error",
        }),
        {
          arguments: [
            new InvokeAgentCommand({
              agentAliasId: "alias-1",
              agentId: "agent-1",
              inputText: "Trigger an error.",
              sessionId: "session-error",
            }) as any,
          ],
        },
      );

    for await (const _event of response.completion) {
      // Consume the response so the instrumented spans can finish.
    }

    const spans = (await backgroundLogger.drain()) as Array<
      Record<string, unknown> & {
        span_attributes?: { name?: string };
      }
    >;
    const parent = spans.find(
      (span) => span.span_attributes?.name === "bedrockAgent.invokeAgent",
    );
    const model = spans.find(
      (span) => span.span_attributes?.name === "bedrockAgent.modelInvocation",
    );
    expect(parent).toMatchObject({
      error: "throttlingException: rate limited",
    });
    expect(model).toMatchObject({
      error: "throttlingException: rate limited",
    });
  });

  it("ignores unrelated Agent Runtime commands and callback sends", async () => {
    const channel = bedrockAgentSmithyCoreChannels.clientSend.tracingChannel();
    await bedrockAgentSmithyCoreChannels.clientSend.tracePromise(
      async () => ({ sessionId: "not-traced" }),
      {
        arguments: [
          new CreateSessionCommand({
            sessionMetadata: { purpose: "not an AI execution" },
          }) as any,
        ],
      },
    );

    const callbackEvent: any = {
      arguments: [
        new InvokeAgentCommand({
          agentAliasId: "alias-1",
          agentId: "agent-1",
          inputText: "ignored",
          sessionId: "session-1",
        }),
        () => {},
      ],
    };
    channel.start?.publish(callbackEvent);
    callbackEvent.result = { completion: [] };
    channel.asyncEnd?.publish(callbackEvent);

    await expect(backgroundLogger.drain()).resolves.toEqual([]);
  });
});
