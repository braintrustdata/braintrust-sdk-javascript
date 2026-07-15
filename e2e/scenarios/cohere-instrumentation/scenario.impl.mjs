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
    dependencyName: "cohere-sdk-v7",
    snapshotName: "cohere-v7",
    supportsThinking: false,
    useV2Namespace: true,
    wrapperEntry: "scenario.cohere-v7.ts",
  },
  {
    apiVersion: "v7",
    autoEntry: "scenario.cohere-v7.mjs",
    dependencyName: "cohere-sdk-v7-latest",
    snapshotName: "cohere-v7-latest",
    supportsThinking: false,
    useV2Namespace: true,
    wrapperEntry: "scenario.cohere-v7.ts",
  },
  {
    apiVersion: "v8",
    autoEntry: "scenario.mjs",
    dependencyName: "cohere-sdk-v8",
    snapshotName: "cohere-v8",
    supportsThinking: false,
    wrapperEntry: "scenario.ts",
  },
  {
    apiVersion: "v8",
    autoEntry: "scenario.mjs",
    dependencyName: "cohere-sdk-v8-latest",
    snapshotName: "cohere-v8-latest",
    supportsThinking: false,
    wrapperEntry: "scenario.ts",
  },
];

function getApiKey() {
  return process.env.COHERE_API_KEY || process.env.CO_API_KEY;
}

function getChatRequest(apiVersion, { stream = false, useV2Api = false } = {}) {
  if (apiVersion === "v8" || useV2Api) {
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

function getOperationName(baseName, { useV2Namespace = false } = {}) {
  return useV2Namespace
    ? `cohere-v2-${baseName}-operation`
    : `cohere-${baseName}-operation`;
}

function getOperationClient(client, { useV2Namespace = false } = {}) {
  if (!useV2Namespace) {
    return client;
  }

  if (!client.v2) {
    throw new Error("Expected Cohere client to expose a v2 namespace");
  }

  return client.v2;
}

async function runCohereInstrumentationScenario(
  CohereClient,
  { apiVersion, decorateClient, ThinkingCohereClient, useV2Namespace } = {},
) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Expected COHERE_API_KEY or CO_API_KEY to be set for e2e");
  }

  const baseClient = new CohereClient({
    environment: process.env.COHERE_BASE_URL,
    token: apiKey,
  });
  const client = decorateClient ? decorateClient(baseClient) : baseClient;
  const operationClient = getOperationClient(client, { useV2Namespace });
  const thinkingClientClass = ThinkingCohereClient ?? CohereClient;
  const thinkingBaseClient =
    thinkingClientClass === CohereClient
      ? baseClient
      : new thinkingClientClass({
          environment: process.env.COHERE_BASE_URL,
          token: apiKey,
        });
  const thinkingClient = decorateClient
    ? decorateClient(thinkingBaseClient)
    : thinkingBaseClient;
  const thinkingOperationClient = getOperationClient(thinkingClient, {
    useV2Namespace: useV2Namespace && thinkingClientClass === CohereClient,
  });

  await runTracedScenario({
    callback: async () => {
      await runOperation(
        getOperationName("chat", { useV2Namespace }),
        "chat",
        async () => {
          await operationClient.chat(
            getChatRequest(apiVersion, { useV2Api: useV2Namespace }),
          );
        },
      );

      await runOperation(
        getOperationName("chat-stream", { useV2Namespace }),
        "chat-stream",
        async () => {
          const stream = await operationClient.chatStream(
            getChatRequest(apiVersion, {
              stream: true,
              useV2Api: useV2Namespace,
            }),
          );
          await collectAsync(stream);
        },
      );

      if (shouldRunThinkingScenario(apiVersion)) {
        await runOperation(
          getOperationName("chat-stream-thinking", { useV2Namespace }),
          "chat-stream-thinking",
          async () => {
            const stream = await thinkingOperationClient.chatStream(
              getThinkingChatRequest(),
            );
            await collectAsync(stream);
          },
        );
      }

      await runOperation(
        getOperationName("embed", { useV2Namespace }),
        "embed",
        async () => {
          await operationClient.embed(getEmbedRequest(apiVersion));
        },
      );

      await runOperation(
        getOperationName("rerank", { useV2Namespace }),
        "rerank",
        async () => {
          await operationClient.rerank(getRerankRequest(apiVersion));
        },
      );
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
