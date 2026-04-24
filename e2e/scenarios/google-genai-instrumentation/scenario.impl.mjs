import { readFile } from "node:fs/promises";
import { wrapGoogleGenAI } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const GOOGLE_MODEL = "gemini-2.5-flash-lite";
const GOOGLE_EMBEDDING_MODEL = "gemini-embedding-001";
const GOOGLE_GROUNDING_MODEL = "gemini-2.5-flash";
const ROOT_NAME = "google-genai-instrumentation-root";
const SCENARIO_NAME = "google-genai-instrumentation";
const GOOGLE_GENAI_RETRY_OPTIONS = {
  attempts: 4,
  delayMs: 1_000,
  maxDelayMs: 8_000,
  shouldRetry: isRetriableGoogleGenAIError,
};
const WEATHER_TOOL = {
  functionDeclarations: [
    {
      name: "get_weather",
      description: "Get the current weather in a given location",
      parametersJsonSchema: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city and state or city and country",
          },
        },
        required: ["location"],
      },
    },
  ],
};
const GOOGLE_SEARCH_TOOL = {
  googleSearch: {},
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getRetryStatus(error) {
  if (!isObject(error)) {
    return undefined;
  }

  const directStatus = error.status;
  if (typeof directStatus === "number") {
    return directStatus;
  }

  const nestedError = error.error;
  if (
    isObject(nestedError) &&
    typeof nestedError.code === "number" &&
    Number.isFinite(nestedError.code)
  ) {
    return nestedError.code;
  }

  return undefined;
}

function isRetriableGoogleGenAIError(error) {
  const status = getRetryStatus(error);
  if (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("request timed out") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("unavailable") ||
    normalizedMessage.includes("high demand")
  );
}

async function withRetry(
  callback,
  {
    attempts = 3,
    delayMs = 1_000,
    maxDelayMs = Number.POSITIVE_INFINITY,
    shouldRetry = () => true,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) {
        throw error;
      }
      const retryDelayMs = Math.min(delayMs * attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw lastError;
}

async function runGoogleGenAIInstrumentationScenario(sdk, options = {}) {
  const imageBase64 = (
    await readFile(new URL("./test-image.png", import.meta.url))
  ).toString("base64");
  const decoratedSDK = options.decorateSDK ? options.decorateSDK(sdk) : sdk;
  const { GoogleGenAI } = decoratedSDK;
  const client = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
  });

  await runTracedScenario({
    callback: async () => {
      await runOperation("google-generate-operation", "generate", async () => {
        await withRetry(async () => {
          await client.models.generateContent({
            model: GOOGLE_MODEL,
            contents: "Reply with exactly PARIS.",
            config: {
              maxOutputTokens: 24,
              temperature: 0,
            },
          });
        }, GOOGLE_GENAI_RETRY_OPTIONS);
      });

      await runOperation("google-embed-operation", "embed", async () => {
        await withRetry(async () => {
          await client.models.embedContent({
            model: GOOGLE_EMBEDDING_MODEL,
            contents: "Paris is the capital of France.",
          });
        }, GOOGLE_GENAI_RETRY_OPTIONS);
      });

      await runOperation(
        "google-attachment-operation",
        "attachment",
        async () => {
          await withRetry(async () => {
            await client.models.generateContent({
              model: GOOGLE_MODEL,
              contents: [
                {
                  parts: [
                    {
                      inlineData: {
                        data: imageBase64,
                        mimeType: "image/png",
                      },
                    },
                    {
                      text: "Describe the attached image in one short sentence.",
                    },
                  ],
                  role: "user",
                },
              ],
              config: {
                maxOutputTokens: 48,
                temperature: 0,
              },
            });
          }, GOOGLE_GENAI_RETRY_OPTIONS);
        },
      );

      await runOperation("google-stream-operation", "stream", async () => {
        await withRetry(async () => {
          const stream = await client.models.generateContentStream({
            model: GOOGLE_MODEL,
            contents: "Count from 1 to 3 and include the words one two three.",
            config: {
              maxOutputTokens: 64,
              temperature: 0,
            },
          });
          await collectAsync(stream);
        }, GOOGLE_GENAI_RETRY_OPTIONS);
      });

      await runOperation(
        "google-stream-return-operation",
        "stream-return",
        async () => {
          await withRetry(async () => {
            const stream = await client.models.generateContentStream({
              model: GOOGLE_MODEL,
              contents: "Reply with exactly BONJOUR.",
              config: {
                maxOutputTokens: 24,
                temperature: 0,
              },
            });

            for await (const _chunk of stream) {
              break;
            }
          }, GOOGLE_GENAI_RETRY_OPTIONS);
        },
      );

      await runOperation(
        "google-grounded-generate-operation",
        "grounded-generate",
        async () => {
          await withRetry(async () => {
            await client.models.generateContent({
              model: GOOGLE_GROUNDING_MODEL,
              contents:
                "Use Google Search grounding and answer in one sentence: What is the current population of Paris, France?",
              config: {
                maxOutputTokens: 256,
                temperature: 0,
                tools: [GOOGLE_SEARCH_TOOL],
              },
            });
          }, GOOGLE_GENAI_RETRY_OPTIONS);
        },
      );

      await runOperation(
        "google-grounded-stream-operation",
        "grounded-stream",
        async () => {
          await withRetry(async () => {
            const stream = await client.models.generateContentStream({
              model: GOOGLE_GROUNDING_MODEL,
              contents:
                "Use Google Search grounding and answer in one sentence: What is the current weather in Paris?",
              config: {
                maxOutputTokens: 256,
                temperature: 0,
                tools: [GOOGLE_SEARCH_TOOL],
              },
            });
            await collectAsync(stream);
          }, GOOGLE_GENAI_RETRY_OPTIONS);
        },
      );

      await runOperation("google-tool-operation", "tool", async () => {
        await withRetry(async () => {
          await client.models.generateContent({
            model: GOOGLE_MODEL,
            contents:
              "Use the get_weather function for Paris, France. Do not answer from memory.",
            config: {
              maxOutputTokens: 128,
              temperature: 0,
              tools: [WEATHER_TOOL],
              toolConfig: {
                functionCallingConfig: {
                  allowedFunctionNames: ["get_weather"],
                  mode: sdk.FunctionCallingConfigMode.ANY,
                },
              },
            },
          });
        }, GOOGLE_GENAI_RETRY_OPTIONS);
      });
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-google-genai-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedGoogleGenAIInstrumentation(sdk) {
  await runGoogleGenAIInstrumentationScenario(sdk, {
    decorateSDK: wrapGoogleGenAI,
  });
}

export async function runAutoGoogleGenAIInstrumentation(sdk) {
  await runGoogleGenAIInstrumentationScenario(sdk);
}

export { GOOGLE_EMBEDDING_MODEL, GOOGLE_MODEL, ROOT_NAME, SCENARIO_NAME };
