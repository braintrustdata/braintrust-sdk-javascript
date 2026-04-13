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
const HUGGINGFACE_SCENARIO_TIMEOUT_MS = 150_000;
const V2_CHAT_ENDPOINT_URL = "https://router.huggingface.co";
const V2_FEATURE_EXTRACTION_ENDPOINT_URL =
  "https://router.huggingface.co/hf-inference/models/thenlper/gte-large/pipeline/feature-extraction";
const V2_TEXT_GENERATION_ENDPOINT_URL =
  "https://router.huggingface.co/featherless-ai/v1/completions";
const HUGGINGFACE_SCENARIO_SPECS = [
  {
    autoEntry: "scenario.huggingface-v281.mjs",
    dependencyName: "huggingface-inference-sdk-v2",
    snapshotName: "huggingface-v281",
    supportsLiveTextGeneration: false,
    wrapperEntry: "scenario.huggingface-v281.ts",
  },
  {
    autoEntry: "scenario.huggingface-v3150.mjs",
    dependencyName: "huggingface-inference-sdk-v3",
    snapshotName: "huggingface-v3150",
    wrapperEntry: "scenario.huggingface-v3150.ts",
  },
  {
    autoEntry: "scenario.mjs",
    dependencyName: "@huggingface/inference",
    snapshotName: "huggingface-v41315",
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
    supportsLiveTextGeneration: options.supportsLiveTextGeneration !== false,
  };
}

function createClient(Client, apiKey, options) {
  const client = new Client(apiKey);

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

      if (capabilities.supportsLiveTextGeneration) {
        await runOperation(
          "huggingface-text-generation-operation",
          "text-generation",
          async () => {
            await decoratedSDK.textGeneration({
              accessToken: apiKey,
              inputs: "The capital of France is",
              model: TEXT_GENERATION_MODEL,
              parameters: {
                do_sample: false,
                max_new_tokens: 4,
                return_full_text: false,
              },
              provider: TEXT_GENERATION_PROVIDER,
            });
          },
        );
      }

      await runOperation(
        "huggingface-text-generation-stream-operation",
        "text-generation-stream",
        async () => {
          const stream = decoratedSDK.textGenerationStream({
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
                  model: TEXT_GENERATION_MODEL,
                  prompt: "The capital of France is",
                }),
          });
          await collectAsync(stream);
        },
      );

      await runOperation(
        "huggingface-feature-extraction-operation",
        "feature-extraction",
        async () => {
          await decoratedSDK.featureExtraction({
            accessToken: apiKey,
            inputs: "Paris France",
            model: EMBEDDING_MODEL,
            ...(capabilities.supportsLiveTextGeneration
              ? { provider: EMBEDDING_PROVIDER }
              : { endpointUrl: V2_FEATURE_EXTRACTION_ENDPOINT_URL }),
          });
        },
      );
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
