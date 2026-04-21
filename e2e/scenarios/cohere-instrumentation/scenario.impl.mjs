import { wrapCohere } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  CHAT_MODEL_V7,
  CHAT_MODEL_V8,
  EMBEDDING_MODEL_V7,
  EMBEDDING_MODEL_V8,
  RERANK_MODEL_V7,
  RERANK_MODEL_V8,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

export const COHERE_SCENARIO_TIMEOUT_MS = 240_000;

export const COHERE_SCENARIO_SPECS = [
  {
    apiVersion: "v7",
    autoEntry: "scenario.cohere-v7.mjs",
    dependencyName: "cohere-sdk-v7-14-0",
    snapshotName: "cohere-v7-14-0",
    supportsThinking: false,
    wrapperEntry: "scenario.cohere-v7.ts",
  },
  {
    apiVersion: "v7",
    autoEntry: "scenario.cohere-v7.mjs",
    dependencyName: "cohere-sdk-v7-20-0",
    snapshotName: "cohere-v7-20-0",
    wrapperEntry: "scenario.cohere-v7.ts",
  },
  {
    apiVersion: "v7",
    autoEntry: "scenario.cohere-v7.mjs",
    dependencyName: "cohere-sdk-v7-21-0",
    snapshotName: "cohere-v7-21-0",
    wrapperEntry: "scenario.cohere-v7.ts",
  },
  {
    apiVersion: "v7",
    autoEntry: "scenario.cohere-v7.mjs",
    dependencyName: "cohere-sdk-v7",
    snapshotName: "cohere-v7",
    wrapperEntry: "scenario.cohere-v7.ts",
  },
  {
    apiVersion: "v8",
    autoEntry: "scenario.mjs",
    dependencyName: "cohere-sdk-v8",
    snapshotName: "cohere-v8",
    wrapperEntry: "scenario.ts",
  },
];

function getApiKey() {
  return process.env.COHERE_API_KEY || process.env.CO_API_KEY;
}

function getChatRequest(apiVersion, { stream = false } = {}) {
  if (apiVersion === "v8") {
    return {
      model: CHAT_MODEL_V8,
      messages: [
        {
          role: "user",
          content: stream
            ? "Reply with exactly STREAM."
            : "Reply with exactly OK.",
        },
      ],
      maxTokens: 32,
      temperature: 0,
    };
  }

  return {
    model: CHAT_MODEL_V7,
    message: stream ? "Reply with exactly STREAM." : "Reply with exactly OK.",
    maxTokens: 32,
    temperature: 0,
  };
}

function getThinkingChatRequest() {
  return {
    model: "command-a-reasoning-08-2025",
    messages: [
      {
        role: "user",
        content: "What is 2+2? Reply with the number only.",
      },
    ],
    maxTokens: 256,
    temperature: 0,
    thinking: {
      type: "enabled",
      tokenBudget: 128,
    },
  };
}

function shouldRunThinkingScenario(apiVersion) {
  if (process.env.COHERE_SUPPORTS_THINKING === "1") {
    return true;
  }

  if (process.env.COHERE_SUPPORTS_THINKING === "0") {
    return false;
  }

  return apiVersion === "v8";
}

function getEmbedRequest(apiVersion) {
  if (apiVersion === "v8") {
    return {
      model: EMBEDDING_MODEL_V8,
      inputType: "search_document",
      texts: ["braintrust tracing"],
      embeddingTypes: ["float"],
    };
  }

  return {
    model: EMBEDDING_MODEL_V7,
    inputType: "search_document",
    texts: ["braintrust tracing"],
    embeddingTypes: ["float"],
  };
}

function getRerankRequest(apiVersion) {
  const documents = [
    "Paris is the capital city of France.",
    "Vienna is the capital city of Austria.",
    "Canberra is the capital city of Australia.",
  ];

  if (apiVersion === "v8") {
    return {
      model: RERANK_MODEL_V8,
      query: "What is the capital of France?",
      documents,
      topN: 2,
    };
  }

  return {
    model: RERANK_MODEL_V7,
    query: "What is the capital of France?",
    documents,
    topN: 2,
  };
}

async function runCohereInstrumentationScenario(
  CohereClient,
  { apiVersion, decorateClient, ThinkingCohereClient } = {},
) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Expected COHERE_API_KEY or CO_API_KEY to be set for e2e");
  }

  const baseClient = new CohereClient({
    token: apiKey,
  });
  const client = decorateClient ? decorateClient(baseClient) : baseClient;
  const thinkingClientClass = ThinkingCohereClient ?? CohereClient;
  const thinkingBaseClient =
    thinkingClientClass === CohereClient
      ? baseClient
      : new thinkingClientClass({
          token: apiKey,
        });
  const thinkingClient = decorateClient
    ? decorateClient(thinkingBaseClient)
    : thinkingBaseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("cohere-chat-operation", "chat", async () => {
        await client.chat(getChatRequest(apiVersion));
      });

      await runOperation(
        "cohere-chat-stream-operation",
        "chat-stream",
        async () => {
          const stream = await client.chatStream(
            getChatRequest(apiVersion, { stream: true }),
          );
          await collectAsync(stream);
        },
      );

      if (shouldRunThinkingScenario(apiVersion)) {
        await runOperation(
          "cohere-chat-stream-thinking-operation",
          "chat-stream-thinking",
          async () => {
            const stream = await thinkingClient.chatStream(
              getThinkingChatRequest(),
            );
            await collectAsync(stream);
          },
        );
      }

      await runOperation("cohere-embed-operation", "embed", async () => {
        await client.embed(getEmbedRequest(apiVersion));
      });

      await runOperation("cohere-rerank-operation", "rerank", async () => {
        await client.rerank(getRerankRequest(apiVersion));
      });
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-cohere-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedCohereInstrumentation(CohereClient, options) {
  await runCohereInstrumentationScenario(CohereClient, {
    decorateClient: wrapCohere,
    ...options,
  });
}

export async function runAutoCohereInstrumentation(CohereClient, options) {
  await runCohereInstrumentationScenario(CohereClient, {
    ...options,
  });
}
