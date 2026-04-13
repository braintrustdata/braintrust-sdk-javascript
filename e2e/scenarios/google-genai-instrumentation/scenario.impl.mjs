import { readFile } from "node:fs/promises";
import { wrapGoogleGenAI } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const GOOGLE_MODEL = "gemini-2.5-flash-lite";
const GOOGLE_GROUNDING_MODEL = "gemini-2.0-flash";
const ROOT_NAME = "google-genai-instrumentation-root";
const SCENARIO_NAME = "google-genai-instrumentation";
const GOOGLE_RETRY_ATTEMPTS = 4;
const GOOGLE_RETRY_BASE_DELAY_MS = 1_000;
const GOOGLE_RETRY_MAX_DELAY_MS = 8_000;
const GOOGLE_RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
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

function shouldRetryGoogleError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const status = "status" in error ? error.status : undefined;
  if (typeof status === "number" && GOOGLE_RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message.toLowerCase()
      : "";
  return (
    message.includes("timed out") ||
    message.includes("high demand") ||
    message.includes("unavailable")
  );
}

async function withGoogleRetry(callback) {
  let lastError;

  for (let attempt = 1; attempt <= GOOGLE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;

      if (attempt >= GOOGLE_RETRY_ATTEMPTS || !shouldRetryGoogleError(error)) {
        throw error;
      }

      const delayMs = Math.min(
        GOOGLE_RETRY_BASE_DELAY_MS * attempt,
        GOOGLE_RETRY_MAX_DELAY_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
        await withGoogleRetry(async () => {
          await client.models.generateContent({
            model: GOOGLE_MODEL,
            contents: "Reply with exactly PARIS.",
            config: {
              maxOutputTokens: 24,
              temperature: 0,
            },
          });
        });
      });

      await runOperation(
        "google-attachment-operation",
        "attachment",
        async () => {
          await withGoogleRetry(async () => {
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
          });
        },
      );

      await runOperation("google-stream-operation", "stream", async () => {
        await withGoogleRetry(async () => {
          const stream = await client.models.generateContentStream({
            model: GOOGLE_MODEL,
            contents: "Count from 1 to 3 and include the words one two three.",
            config: {
              maxOutputTokens: 64,
              temperature: 0,
            },
          });
          await collectAsync(stream);
        });
      });

      await runOperation(
        "google-stream-return-operation",
        "stream-return",
        async () => {
          await withGoogleRetry(async () => {
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
          });
        },
      );

      await runOperation(
        "google-grounded-generate-operation",
        "grounded-generate",
        async () => {
          await withGoogleRetry(async () => {
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
          });
        },
      );

      await runOperation(
        "google-grounded-stream-operation",
        "grounded-stream",
        async () => {
          await withGoogleRetry(async () => {
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
          });
        },
      );

      await runOperation("google-tool-operation", "tool", async () => {
        await withGoogleRetry(async () => {
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
        });
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

export { GOOGLE_MODEL, ROOT_NAME, SCENARIO_NAME };
