import { wrapHuggingFace } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const CHAT_MODEL = "meta-llama/Llama-3.1-8B-Instruct";
const CHAT_PROVIDER = "featherless-ai";
const EMBEDDING_MODEL = "thenlper/gte-large";
const EMBEDDING_PROVIDER = "hf-inference";
const ROOT_NAME = "huggingface-instrumentation-root";
const SCENARIO_NAME = "huggingface-instrumentation";
const TEXT_GENERATION_MODEL = "meta-llama/Llama-3.1-8B";
const TEXT_GENERATION_PROVIDER = "featherless-ai";
const V2_TEXT_GENERATION_MODEL = "arcee-ai/Trinity-Large-Thinking";
const TOOL_NAME = "get_current_weather";
const CHAT_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City and state or city and country.",
        },
      },
      required: ["location"],
    },
  },
};
const HUGGINGFACE_SCENARIO_TIMEOUT_MS = 150_000;
const HUGGINGFACE_BASE_URL =
  process.env.HUGGINGFACE_BASE_URL ?? "https://huggingface.co";
const HUGGINGFACE_ROUTER_BASE_URL =
  process.env.HUGGINGFACE_ROUTER_BASE_URL ?? "https://router.huggingface.co";
const V2_CHAT_ENDPOINT_URL = HUGGINGFACE_ROUTER_BASE_URL;
const V2_FEATURE_EXTRACTION_ENDPOINT_URL = `${HUGGINGFACE_ROUTER_BASE_URL}/hf-inference/models/thenlper/gte-large/pipeline/feature-extraction`;
const V2_TEXT_GENERATION_ENDPOINT_URL = `${HUGGINGFACE_ROUTER_BASE_URL}/featherless-ai/v1/completions`;
const HUGGINGFACE_SCENARIO_SPECS = [
  {
    autoEntry: "scenario.huggingface-v281.mjs",
    dependencyName: "huggingface-inference-sdk-v2",
    snapshotName: "huggingface-v2",
    supportsChatStream: false,
    supportsFeatureExtraction: false,
    supportsLiveTextGeneration: false,
    supportsTextGenerationStream: false,
    supportsToolCalls: false,
    wrapperEntry: "scenario.huggingface-v281.ts",
  },
  {
    autoEntry: "scenario.huggingface-v281.mjs",
    dependencyName: "huggingface-inference-sdk-v2-latest",
    snapshotName: "huggingface-v2-latest",
    supportsChatStream: false,
    supportsFeatureExtraction: false,
    supportsLiveTextGeneration: false,
    supportsTextGenerationStream: false,
    supportsToolCalls: false,
    wrapperEntry: "scenario.huggingface-v281.ts",
  },
  {
    autoEntry: "scenario.huggingface-v3150.mjs",
    dependencyName: "huggingface-inference-sdk-v3",
    snapshotName: "huggingface-v3",
    wrapperEntry: "scenario.huggingface-v3150.ts",
  },
  {
    autoEntry: "scenario.huggingface-v3150.mjs",
    dependencyName: "huggingface-inference-sdk-v3-latest",
    snapshotName: "huggingface-v3-latest",
    wrapperEntry: "scenario.huggingface-v3150.ts",
  },
  {
    autoEntry: "scenario.mjs",
    dependencyName: "huggingface-inference-sdk-v4",
    snapshotName: "huggingface-v4",
    wrapperEntry: "scenario.ts",
  },
  {
    autoEntry: "scenario.mjs",
    dependencyName: "huggingface-inference-sdk-v4-latest",
    snapshotName: "huggingface-v4-latest",
    wrapperEntry: "scenario.ts",
  },
];

function getClientConstructor(sdk) {
  return sdk.InferenceClient ?? sdk.HfInference;
}

function getHuggingFaceApiKey() {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    throw new Error("HUGGINGFACE_API_KEY must be set for this scenario");
  }
  return apiKey;
}

function getScenarioCapabilities(options) {
  return {
    supportsChatStream: options.supportsChatStream !== false,
    supportsFeatureExtraction: options.supportsFeatureExtraction !== false,
    supportsLiveTextGeneration: options.supportsLiveTextGeneration !== false,
    supportsTextGenerationStream:
      options.supportsTextGenerationStream !== false,
    supportsToolCalls: options.supportsToolCalls !== false,
  };
}

function rewriteHuggingFaceUrl(value) {
  const url = new URL(value);
  if (url.origin === "https://huggingface.co") {
    return `${HUGGINGFACE_BASE_URL}${url.pathname}${url.search}${url.hash}`;
  }
  if (url.origin === "https://router.huggingface.co") {
    return `${HUGGINGFACE_ROUTER_BASE_URL}${url.pathname}${url.search}${url.hash}`;
  }
  return value;
}

function createHuggingFaceFetch() {
  if (!process.env.BRAINTRUST_E2E_CASSETTE_SERVER_URL) {
    return undefined;
  }

  return (input, init) => {
    if (input instanceof Request) {
      return fetch(new Request(rewriteHuggingFaceUrl(input.url), input), init);
    }
    return fetch(rewriteHuggingFaceUrl(String(input)), init);
  };
}

const HUGGINGFACE_FETCH = createHuggingFaceFetch();
const HUGGINGFACE_REQUEST_OPTIONS = HUGGINGFACE_FETCH
  ? { fetch: HUGGINGFACE_FETCH }
  : undefined;

function createClient(Client, apiKey, options) {
  const client = new Client(apiKey, HUGGINGFACE_REQUEST_OPTIONS);

  if (options.supportsLiveTextGeneration === false) {
    if (typeof client.endpoint !== "function") {
      throw new Error("Expected HuggingFace v2 client to support endpoint()");
    }

    return client.endpoint(V2_CHAT_ENDPOINT_URL);
  }

  return client;
}

async function runHuggingFaceInstrumentationScenario(sdk, options = {}) {
  const decoratedSDK = options.decorateSDK ? options.decorateSDK(sdk) : sdk;
  const Client = getClientConstructor(decoratedSDK);
  const apiKey = getHuggingFaceApiKey();
  const capabilities = getScenarioCapabilities(options);

  if (!Client) {
    throw new Error("Could not resolve a HuggingFace client constructor");
  }

  const client = createClient(Client, apiKey, capabilities);

  await runTracedScenario({
    callback: async () => {
      await runOperation("huggingface-chat-operation", "chat", async () => {
        await client.chatCompletion({
          max_tokens: 16,
          messages: [
            {
              role: "user",
              content: "Reply with exactly OK.",
            },
          ],
          model: CHAT_MODEL,
          ...(capabilities.supportsLiveTextGeneration
            ? { provider: CHAT_PROVIDER }
            : {}),
          temperature: 0,
        });
      });

      if (capabilities.supportsChatStream) {
        await runOperation(
          "huggingface-chat-stream-operation",
          "chat-stream",
          async () => {
            const stream = client.chatCompletionStream({
              max_tokens: 16,
              messages: [
                {
                  role: "user",
                  content: "Reply with exactly OK.",
                },
              ],
              model: CHAT_MODEL,
              ...(capabilities.supportsLiveTextGeneration
                ? { provider: CHAT_PROVIDER }
                : {}),
              temperature: 0,
            });
            await collectAsync(stream);
          },
        );
      }

      if (capabilities.supportsToolCalls) {
        await runOperation(
          "huggingface-chat-stream-tool-call-operation",
          "chat-stream-tool-call",
          async () => {
            const stream = client.chatCompletionStream({
              max_tokens: 64,
              messages: [
                {
                  role: "user",
                  content: `What is the weather in San Francisco? Call the ${TOOL_NAME} tool.`,
                },
              ],
              model: CHAT_MODEL,
              provider: CHAT_PROVIDER,
              temperature: 0,
              tool_choice: "required",
              tools: [CHAT_TOOL],
            });
            await collectAsync(stream);
          },
        );
      }

      if (capabilities.supportsLiveTextGeneration) {
        await runOperation(
          "huggingface-text-generation-operation",
          "text-generation",
          async () => {
            await decoratedSDK.textGeneration(
              {
                accessToken: apiKey,
                inputs: "The capital of France is",
                model: TEXT_GENERATION_MODEL,
                parameters: {
                  do_sample: false,
                  max_new_tokens: 4,
                  return_full_text: false,
                },
                provider: TEXT_GENERATION_PROVIDER,
              },
              HUGGINGFACE_REQUEST_OPTIONS,
            );
          },
        );
      }

      if (capabilities.supportsTextGenerationStream) {
        await runOperation(
          "huggingface-text-generation-stream-operation",
          "text-generation-stream",
          async () => {
            const stream = decoratedSDK.textGenerationStream(
              {
                ...(capabilities.supportsLiveTextGeneration
                  ? {
                      accessToken: apiKey,
                      inputs: "The capital of France is",
                      model: TEXT_GENERATION_MODEL,
                      parameters: {
                        do_sample: false,
                        max_new_tokens: 4,
                        return_full_text: false,
                      },
                      provider: TEXT_GENERATION_PROVIDER,
                    }
                  : {
                      accessToken: apiKey,
                      endpointUrl: V2_TEXT_GENERATION_ENDPOINT_URL,
                      inputs: "The capital of France is",
                      max_tokens: 4,
                      model: V2_TEXT_GENERATION_MODEL,
                      prompt: "The capital of France is",
                    }),
              },
              HUGGINGFACE_REQUEST_OPTIONS,
            );
            await collectAsync(stream);
          },
        );
      }

      if (capabilities.supportsFeatureExtraction) {
        await runOperation(
          "huggingface-feature-extraction-operation",
          "feature-extraction",
          async () => {
            await decoratedSDK.featureExtraction(
              {
                accessToken: apiKey,
                inputs: "Paris France",
                model: EMBEDDING_MODEL,
                ...(capabilities.supportsLiveTextGeneration
                  ? { provider: EMBEDDING_PROVIDER }
                  : { endpointUrl: V2_FEATURE_EXTRACTION_ENDPOINT_URL }),
              },
              HUGGINGFACE_REQUEST_OPTIONS,
            );
          },
        );
      }
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-huggingface-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedHuggingFaceInstrumentation(sdk, options = {}) {
  await runHuggingFaceInstrumentationScenario(sdk, {
    ...options,
    decorateSDK: wrapHuggingFace,
  });
}

export async function runAutoHuggingFaceInstrumentation(sdk, options = {}) {
  await runHuggingFaceInstrumentationScenario(sdk, options);
}

export {
  CHAT_MODEL,
  EMBEDDING_MODEL,
  HUGGINGFACE_SCENARIO_SPECS,
  HUGGINGFACE_SCENARIO_TIMEOUT_MS,
  ROOT_NAME,
  SCENARIO_NAME,
  TEXT_GENERATION_MODEL,
};
