import { wrapBedrockAgentRuntime } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  AGENT_OPERATION_NAME,
  INLINE_OPERATION_NAME,
  MODEL,
  RAG_OPERATION_NAME,
  RAG_STREAM_OPERATION_NAME,
  REGION,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

export const BEDROCK_AGENT_RUNTIME_SCENARIO_TIMEOUT_MS = 180_000;

function traceEvent(trace) {
  return {
    trace: {
      agentAliasId: "alias-1",
      agentId: "agent-1",
      agentVersion: "1",
      sessionId: "session-1",
      trace,
    },
  };
}

function modelTraceEvents(traceId, output) {
  return [
    traceEvent({
      orchestrationTrace: {
        modelInvocationInput: {
          foundationModel: MODEL,
          inferenceConfiguration: {
            maximumLength: 128,
            temperature: 0,
          },
          text: "deterministic Bedrock agent model prompt",
          traceId,
          type: "ORCHESTRATION",
        },
      },
    }),
    traceEvent({
      orchestrationTrace: {
        modelInvocationOutput: {
          metadata: {
            usage: {
              inputTokens: 12,
              outputTokens: 4,
            },
          },
          rawResponse: {
            content: JSON.stringify(output),
          },
          traceId,
        },
      },
    }),
  ];
}

async function* invokeAgentCompletion() {
  for (const event of modelTraceEvents("agent-model", {
    action: "get_weather",
  })) {
    yield event;
  }
  yield traceEvent({
    orchestrationTrace: {
      invocationInput: {
        actionGroupInvocationInput: {
          actionGroupName: "weather",
          function: "get_weather",
          parameters: [{ name: "city", value: "Paris" }],
        },
        traceId: "agent-tool",
      },
    },
  });
  yield traceEvent({
    orchestrationTrace: {
      observation: {
        actionGroupInvocationOutput: {
          text: JSON.stringify({ temperature: 18 }),
        },
        traceId: "agent-tool",
        type: "ACTION_GROUP",
      },
    },
  });
  yield {
    chunk: {
      bytes: new TextEncoder().encode("AGENT_OK"),
    },
  };
}

async function* invokeInlineAgentCompletion() {
  for (const event of modelTraceEvents("inline-model", {
    answer: "INLINE_OK",
  })) {
    yield event;
  }
  yield {
    chunk: {
      bytes: new TextEncoder().encode("INLINE_OK"),
    },
  };
}

async function* retrieveAndGenerateStream() {
  yield { output: { text: "STREAM_" } };
  yield { output: { text: "RAG_OK" } };
  yield {
    citation: {
      generatedResponsePart: {
        textResponsePart: {
          span: { start: 0, end: 12 },
          text: "STREAM_RAG_OK",
        },
      },
      retrievedReferences: [
        {
          content: { text: "Deterministic knowledge-base reference." },
          location: {
            type: "WEB",
            webLocation: { url: "https://example.com/reference" },
          },
        },
      ],
    },
  };
  yield { guardrail: { action: "NONE" } };
}

function responseFor(commandName) {
  switch (commandName) {
    case "InvokeAgentCommand":
      return {
        $metadata: { httpStatusCode: 200, requestId: "request-agent" },
        completion: invokeAgentCompletion(),
        contentType: "application/json",
        sessionId: "session-1",
      };
    case "InvokeInlineAgentCommand":
      return {
        $metadata: { httpStatusCode: 200, requestId: "request-inline" },
        completion: invokeInlineAgentCompletion(),
        contentType: "application/json",
        sessionId: "session-inline",
      };
    case "RetrieveAndGenerateCommand":
      return {
        $metadata: { httpStatusCode: 200, requestId: "request-rag" },
        citations: [
          {
            generatedResponsePart: {
              textResponsePart: { text: "RAG_OK" },
            },
          },
        ],
        guardrailAction: "NONE",
        output: { text: "RAG_OK" },
        sessionId: "session-rag",
      };
    case "RetrieveAndGenerateStreamCommand":
      return {
        $metadata: { httpStatusCode: 200, requestId: "request-rag-stream" },
        sessionId: "session-rag-stream",
        stream: retrieveAndGenerateStream(),
      };
    default:
      throw new Error(
        `Unexpected Bedrock Agent Runtime command: ${commandName}`,
      );
  }
}

function installDeterministicBackend(client) {
  client.middlewareStack.add(
    (_next, context) => async () => ({
      output: responseFor(context.commandName),
      response: {},
    }),
    {
      name: "braintrustBedrockAgentRuntimeE2EBackend",
      priority: "high",
      step: "initialize",
    },
  );
}

function knowledgeBaseConfiguration() {
  return {
    knowledgeBaseConfiguration: {
      knowledgeBaseId: "kb-1",
      modelArn: `arn:aws:bedrock:${REGION}:000000000000:foundation-model/${MODEL}`,
    },
    type: "KNOWLEDGE_BASE",
  };
}

export async function runBedrockAgentRuntimeInstrumentationScenario(options) {
  const baseClient = new options.BedrockAgentRuntimeClient({
    credentials: {
      accessKeyId: "e2e-access-key",
      secretAccessKey: "e2e-secret-key",
    },
    region: REGION,
  });
  installDeterministicBackend(baseClient);
  const client = options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;

  try {
    await runTracedScenario({
      callback: async () => {
        await runOperation(AGENT_OPERATION_NAME, "invoke-agent", async () => {
          const response = await client.send(
            new options.InvokeAgentCommand({
              agentAliasId: "alias-1",
              agentId: "agent-1",
              enableTrace: true,
              inputText: "Use the weather tool and reply with AGENT_OK.",
              sessionId: "session-1",
            }),
          );
          await collectAsync(response.completion ?? []);
        });

        await runOperation(
          INLINE_OPERATION_NAME,
          "invoke-inline-agent",
          async () => {
            const response = await client.send(
              new options.InvokeInlineAgentCommand({
                agentName: "braintrust-e2e-inline-agent",
                enableTrace: true,
                endSession: true,
                foundationModel: MODEL,
                inputText: "Reply with exactly INLINE_OK.",
                instruction:
                  "Follow the user's requested response format exactly.",
                sessionId: "session-inline",
              }),
            );
            await collectAsync(response.completion ?? []);
          },
        );

        await runOperation(
          RAG_OPERATION_NAME,
          "retrieve-and-generate",
          async () => {
            await client.send(
              new options.RetrieveAndGenerateCommand({
                input: { text: "Return the deterministic RAG answer." },
                retrieveAndGenerateConfiguration: knowledgeBaseConfiguration(),
              }),
            );
          },
        );

        await runOperation(
          RAG_STREAM_OPERATION_NAME,
          "retrieve-and-generate-stream",
          async () => {
            const response = await client.send(
              new options.RetrieveAndGenerateStreamCommand({
                input: { text: "Stream the deterministic RAG answer." },
                retrieveAndGenerateConfiguration: knowledgeBaseConfiguration(),
              }),
            );
            await collectAsync(response.stream ?? []);
          },
        );
      },
      metadata: {
        scenario: SCENARIO_NAME,
      },
      projectNameBase: "e2e-bedrock-agent-runtime-instrumentation",
      rootName: ROOT_NAME,
    });
  } finally {
    baseClient.destroy();
  }
}

export async function runWrappedBedrockAgentRuntimeInstrumentation(options) {
  await runBedrockAgentRuntimeInstrumentationScenario({
    decorateClient: wrapBedrockAgentRuntime,
    ...options,
  });
}

export async function runAutoBedrockAgentRuntimeInstrumentation(options) {
  await runBedrockAgentRuntimeInstrumentationScenario(options);
}
