import { wrapOpenRouter } from "braintrust";
import { z } from "zod";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  CHAT_MODEL,
  EMBEDDING_MODEL,
  RERANK_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

function createWeatherTool() {
  return {
    type: "function",
    function: {
      name: "lookup_weather",
      description: "Look up the weather forecast for a city.",
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        forecast: z.string(),
      }),
      execute: async ({ city }) => ({
        forecast: `Sunny in ${city}`,
      }),
    },
  };
}

function withCompatibleChatRequest(chatGenerationParams) {
  return {
    chatGenerationParams,
    chatRequest: chatGenerationParams,
  };
}

function withCompatibleResponsesRequest(openResponsesRequest) {
  return {
    openResponsesRequest,
    responsesRequest: openResponsesRequest,
  };
}

async function runOpenRouterInstrumentationScenario(
  OpenRouter,
  { decorateClient, supportsRerank = true } = {},
) {
  const baseClient = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const client = decorateClient ? decorateClient(baseClient) : baseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("openrouter-chat-operation", "chat", async () => {
        await client.chat.send(
          withCompatibleChatRequest({
            model: CHAT_MODEL,
            messages: [{ role: "user", content: "Reply with exactly OK." }],
            maxTokens: 24,
            temperature: 0,
          }),
        );
      });

      await runOperation(
        "openrouter-chat-stream-operation",
        "chat-stream",
        async () => {
          const stream = await client.chat.send(
            withCompatibleChatRequest({
              model: CHAT_MODEL,
              messages: [
                { role: "user", content: "Reply with exactly STREAM." },
              ],
              maxTokens: 24,
              stream: true,
              streamOptions: {
                includeUsage: true,
              },
              temperature: 0,
            }),
          );
          await collectAsync(stream);
        },
      );

      await runOperation(
        "openrouter-embeddings-operation",
        "embeddings",
        async () => {
          await client.embeddings.generate({
            requestBody: {
              input: "braintrust tracing",
              inputType: "query",
              model: EMBEDDING_MODEL,
            },
          });
        },
      );

      await runOperation(
        "openrouter-responses-operation",
        "responses",
        async () => {
          await client.beta.responses.send(
            withCompatibleResponsesRequest({
              input: "Reply with exactly OBSERVABILITY.",
              maxOutputTokens: 24,
              model: CHAT_MODEL,
              temperature: 0,
            }),
          );
        },
      );

      await runOperation(
        "openrouter-responses-stream-operation",
        "responses-stream",
        async () => {
          const stream = await client.beta.responses.send(
            withCompatibleResponsesRequest({
              input: "Reply with exactly STREAMED RESPONSE.",
              maxOutputTokens: 24,
              model: CHAT_MODEL,
              stream: true,
              temperature: 0,
            }),
          );
          await collectAsync(stream);
        },
      );

      if (supportsRerank) {
        await runOperation(
          "openrouter-rerank-operation",
          "rerank",
          async () => {
            await client.rerank.rerank({
              requestBody: {
                documents: [
                  "Athens is in Greece.",
                  "Paris is in France.",
                  "Lima is in Peru.",
                ],
                model: RERANK_MODEL,
                query: "Which document is about France?",
                topN: 2,
              },
            });
          },
        );
      }

      await runOperation(
        "openrouter-call-model-operation",
        "call-model",
        async () => {
          const result = client.callModel({
            input:
              "Use the lookup_weather tool for Vienna exactly once, then answer with only the forecast.",
            maxOutputTokens: 24,
            maxToolCalls: 1,
            model: CHAT_MODEL,
            temperature: 0,
            toolChoice: "required",
            tools: [createWeatherTool()],
          });

          await result.getText();
        },
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-openrouter-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedOpenRouterInstrumentation(
  OpenRouter,
  options = {},
) {
  await runOpenRouterInstrumentationScenario(OpenRouter, {
    ...options,
    decorateClient: wrapOpenRouter,
  });
}

export async function runAutoOpenRouterInstrumentation(
  OpenRouter,
  options = {},
) {
  await runOpenRouterInstrumentationScenario(OpenRouter, options);
}
