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
const GOOGLE_INTERACTIONS_MODEL = "gemini-2.5-flash";
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
    ...(process.env.GOOGLE_GENAI_BASE_URL
      ? { httpOptions: { baseUrl: process.env.GOOGLE_GENAI_BASE_URL } }
      : {}),
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

      await runOperation(
        "google-system-instruction-operation",
        "system-instruction",
        async () => {
          await withRetry(async () => {
            await client.models.generateContent({
              model: GOOGLE_MODEL,
              contents: "Tell me about the weather.",
              config: {
                maxOutputTokens: 64,
                systemInstruction:
                  "You are a pirate. Always respond in pirate speak.",
                temperature: 0,
              },
            });
          }, GOOGLE_GENAI_RETRY_OPTIONS);
        },
      );

      await runOperation(
        "google-multi-turn-operation",
        "multi-turn",
        async () => {
          await withRetry(async () => {
            await client.models.generateContent({
              model: GOOGLE_MODEL,
              contents: [
                {
                  role: "user",
                  parts: [{ text: "Hi, my name is Alice." }],
                },
                {
                  role: "model",
                  parts: [{ text: "Hello Alice! Nice to meet you." }],
                },
                {
                  role: "user",
                  parts: [{ text: "What did I just tell you my name was?" }],
                },
              ],
              config: {
                maxOutputTokens: 64,
                temperature: 0,
              },
            });
          }, GOOGLE_GENAI_RETRY_OPTIONS);
        },
      );

      await runOperation("google-embed-operation", "embed", async () => {
        await withRetry(async () => {
          await client.models.embedContent({
            model: GOOGLE_EMBEDDING_MODEL,
            contents: "Paris is the capital of France.",
          });
        }, GOOGLE_GENAI_RETRY_OPTIONS);
      });

      if (options.includeInteractions) {
        await runOperation(
          "google-interaction-operation",
          "interaction",
          async () => {
            await withRetry(async () => {
              await client.interactions.create({
                model: GOOGLE_INTERACTIONS_MODEL,
                input: {
                  text: "Reply with exactly ROME.",
                  type: "text",
                },
                generation_config: {
                  max_output_tokens: 256,
                  thinking_level: "minimal",
                  temperature: 0,
                },
              });
            }, GOOGLE_GENAI_RETRY_OPTIONS);
          },
        );

        await runOperation(
          "google-interaction-stream-operation",
          "interaction-stream",
          async () => {
            await withRetry(async () => {
              const stream = await client.interactions.create({
                model: GOOGLE_INTERACTIONS_MODEL,
                input: {
                  text: "Count from 1 to 3 and include the words one two three.",
                  type: "text",
                },
                generation_config: {
                  max_output_tokens: 256,
                  thinking_level: "minimal",
                  temperature: 0,
                },
                stream: true,
              });
              await collectAsync(stream);
            }, GOOGLE_GENAI_RETRY_OPTIONS);
          },
        );

        let statefulInteractionId;
        await runOperation(
          "google-interaction-stateful-first-operation",
          "interaction-stateful-first",
          async () => {
            await withRetry(async () => {
              const interaction = await client.interactions.create({
                model: GOOGLE_INTERACTIONS_MODEL,
                input: {
                  text: "Hi, my name is Amir.",
                  type: "text",
                },
                generation_config: {
                  max_output_tokens: 256,
                  thinking_level: "minimal",
                  temperature: 0,
                },
              });
              statefulInteractionId = interaction.id;
            }, GOOGLE_GENAI_RETRY_OPTIONS);
          },
        );

        if (!statefulInteractionId) {
          throw new Error("Missing stateful interaction id");
        }

        await runOperation(
          "google-interaction-stateful-second-operation",
          "interaction-stateful-second",
          async () => {
            await withRetry(async () => {
              await client.interactions.create({
                model: GOOGLE_INTERACTIONS_MODEL,
                input: {
                  text: "What is my name? Reply with exactly AMIR.",
                  type: "text",
                },
                previous_interaction_id: statefulInteractionId,
                generation_config: {
                  max_output_tokens: 256,
                  thinking_level: "minimal",
                  temperature: 0,
                },
              });
            }, GOOGLE_GENAI_RETRY_OPTIONS);
          },
        );

        await runOperation(
          "google-interaction-background-operation",
          "interaction-background",
          async () => {
            try {
              await withRetry(async () => {
                await client.interactions.create({
                  model: GOOGLE_INTERACTIONS_MODEL,
                  input: {
                    text: "Reply with exactly BACKGROUND.",
                    type: "text",
                  },
                  background: true,
                  generation_config: {
                    max_output_tokens: 256,
                    thinking_level: "minimal",
                    temperature: 0,
                  },
                });
              }, GOOGLE_GENAI_RETRY_OPTIONS);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error ?? "");
              if (
                getRetryStatus(error) !== 400 ||
                !message.includes("does not support background interactions")
              ) {
                throw error;
              }
            }
          },
        );
      }

      // TODO(lforst): Figure out why these tests are failing with ordinary google gemini api keys
      // await runOperation("google-chat-operation", "chat", async () => {
      //   await withRetry(async () => {
      //     const chat = client.chats.create({
      //       model: GOOGLE_MODEL,
      //       config: {
      //         maxOutputTokens: 24,
      //         temperature: 0,
      //       },
      //     });

      //     await chat.sendMessage({
      //       message: "Reply with exactly MADRID.",
      //     });
      //   }, GOOGLE_GENAI_RETRY_OPTIONS);
      // });
      // await runOperation(
      //   "google-chat-stream-operation",
      //   "chat-stream",
      //   async () => {
      //     await withRetry(async () => {
      //       const chat = client.chats.create({
      //         model: GOOGLE_MODEL,
      //         config: {
      //           maxOutputTokens: 64,
      //           temperature: 0,
      //         },
      //       });

      //       const stream = await chat.sendMessageStream({
      //         message: "Count from 1 to 3 and include the words one two three.",
      //       });
      //       await collectAsync(stream);
      //     }, GOOGLE_GENAI_RETRY_OPTIONS);
      //   },
      // );

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

      await runOperation(
        "google-multi-tool-operation",
        "multi-tool",
        async () => {
          await withRetry(async () => {
            await client.models.generateContent({
              model: GOOGLE_MODEL,
              contents:
                "Use the get_weather function for New York and get_time for Tokyo. Do not answer from memory.",
              config: {
                maxOutputTokens: 128,
                temperature: 0,
                tools: [
                  {
                    functionDeclarations: [
                      {
                        name: "get_weather",
                        description: "Get the weather for a location",
                        parametersJsonSchema: {
                          type: "object",
                          properties: {
                            location: {
                              type: "string",
                              description: "The location to get weather for",
                            },
                          },
                          required: ["location"],
                        },
                      },
                      {
                        name: "get_time",
                        description: "Get the current time for a timezone",
                        parametersJsonSchema: {
                          type: "object",
                          properties: {
                            timezone: {
                              type: "string",
                              description: "The timezone to get time for",
                            },
                          },
                          required: ["timezone"],
                        },
                      },
                    ],
                  },
                ],
                toolConfig: {
                  functionCallingConfig: {
                    allowedFunctionNames: ["get_weather", "get_time"],
                    mode: sdk.FunctionCallingConfigMode.ANY,
                  },
                },
              },
            });
          }, GOOGLE_GENAI_RETRY_OPTIONS);
        },
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-google-genai-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedGoogleGenAIInstrumentation(sdk, options = {}) {
  await runGoogleGenAIInstrumentationScenario(sdk, {
    ...options,
    decorateSDK: wrapGoogleGenAI,
  });
}

export async function runAutoGoogleGenAIInstrumentation(sdk, options = {}) {
  await runGoogleGenAIInstrumentationScenario(sdk, options);
}

export {
  GOOGLE_EMBEDDING_MODEL,
  GOOGLE_INTERACTIONS_MODEL,
  GOOGLE_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
};
