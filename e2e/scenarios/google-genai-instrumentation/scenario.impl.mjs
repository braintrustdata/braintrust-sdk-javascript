import { runMultimodalEmbeddings } from "./embeddings.mjs";
import { readFile } from "node:fs/promises";
import { wrapGoogleGenAI } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const GOOGLE_MODEL = "gemini-2.5-flash";
const GOOGLE_EMBEDDING_MODEL = "gemini-embedding-001";
const GOOGLE_GROUNDING_MODEL = "gemini-2.5-flash";
const GOOGLE_IMAGE_MODEL = "gemini-2.5-flash-image";
const GOOGLE_EDIT_IMAGE_MODEL = "imagen-3.0-capability-001";
const GOOGLE_INTERACTIONS_MODEL = "gemini-2.5-flash";
const GOOGLE_VIDEO_MODEL = "gemini-omni-1.1-flash";
const GOOGLE_VEO_MODEL = "veo-3.1-lite-generate-preview";
const GOOGLE_LEGACY_IMAGE_MODEL = "imagen-4.0-fast-generate-001";
const ROOT_NAME = "google-genai-instrumentation-root";
const SCENARIO_NAME = "google-genai-instrumentation";
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

async function withGoogleGenAIRetry(callback) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await callback();
    } catch (error) {
      const status = getRetryStatus(error);
      if (
        attempt === 3 ||
        !(
          status === 408 ||
          status === 409 ||
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504
        )
      ) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 100));
    }
  }
}

async function generateImageWithRetry(client, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await withGoogleGenAIRetry(async () =>
      client.models.generateContent(params),
    );
    const generatedImage = response.candidates?.some((candidate) =>
      candidate.content?.parts?.some((part) => part.inlineData?.data),
    );
    if (generatedImage) {
      return response;
    }
    if (attempt === 3) {
      throw new Error("Google GenAI returned no generated image");
    }
  }
}

async function generateImageStreamWithRetry(client, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const chunks = await withGoogleGenAIRetry(async () =>
      collectAsync(await client.models.generateContentStream(params)),
    );
    const generatedImage = chunks.some((response) =>
      response.candidates?.some((candidate) =>
        candidate.content?.parts?.some((part) => part.inlineData?.data),
      ),
    );
    if (generatedImage) {
      return;
    }
    if (attempt === 3) {
      throw new Error("Google GenAI stream returned no generated image");
    }
  }
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
        await withGoogleGenAIRetry(async () => {
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
        "google-image-generate-operation",
        "image-generate",
        async () => {
          await generateImageWithRetry(client, {
            model: GOOGLE_IMAGE_MODEL,
            contents:
              "Create a small solid blue circle centered on a white background.",
            config: {
              imageConfig: { aspectRatio: "1:1" },
              responseModalities: ["IMAGE"],
            },
          });
        },
      );

      await runOperation(
        "google-image-generate-stream-operation",
        "image-generate-stream",
        async () => {
          await generateImageStreamWithRetry(client, {
            model: GOOGLE_IMAGE_MODEL,
            contents:
              "Create a small solid red triangle centered on a white background.",
            config: {
              imageConfig: { aspectRatio: "1:1" },
              responseModalities: ["IMAGE"],
            },
          });
        },
      );

      await runOperation(
        "google-native-image-edit-operation",
        "native-image-edit",
        async () => {
          await generateImageWithRetry(client, {
            model: GOOGLE_IMAGE_MODEL,
            contents: [
              {
                role: "user",
                parts: [
                  {
                    inlineData: {
                      data: imageBase64,
                      mimeType: "image/png",
                    },
                  },
                  {
                    text: "Edit this image so the ocean waves are emerald green. Preserve the ship, sky, and composition.",
                  },
                ],
              },
            ],
            config: {
              imageConfig: { aspectRatio: "1:1" },
              responseModalities: ["IMAGE"],
            },
          });
        },
      );

      await runOperation(
        "google-edit-image-operation",
        "edit-image",
        async () => {
          const referenceImage = new sdk.RawReferenceImage();
          referenceImage.referenceImage = {
            imageBytes: imageBase64,
            mimeType: "image/png",
          };
          referenceImage.referenceId = 1;
          try {
            await withGoogleGenAIRetry(async () => {
              await client.models.editImage({
                model: GOOGLE_EDIT_IMAGE_MODEL,
                prompt: "Change the blue circle to green.",
                referenceImages: [referenceImage],
                config: {
                  aspectRatio: "1:1",
                  numberOfImages: 1,
                  outputMimeType: "image/png",
                },
              });
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error ?? "");
            if (
              getRetryStatus(error) !== 404 &&
              !message.includes("only supported by")
            ) {
              throw error;
            }
          }
        },
      );

      await runOperation(
        "google-generate-videos-operation",
        "generate-videos",
        async () => {
          try {
            await withGoogleGenAIRetry(async () => {
              await client.models.generateVideos({
                model: GOOGLE_VEO_MODEL,
                source: {
                  prompt:
                    "A blue circle moves slowly from left to right on a white background.",
                },
                config: {
                  aspectRatio: "16:9",
                  durationSeconds: 4,
                  numberOfVideos: 1,
                  resolution: "720p",
                },
              });
            });
          } catch (error) {
            const status = getRetryStatus(error);
            if (status !== 400 && status !== 403 && status !== 404) {
              throw error;
            }
          }
        },
      );

      await runOperation(
        "google-legacy-image-generate-operation",
        "legacy-image-generate",
        async () => {
          try {
            await withGoogleGenAIRetry(async () => {
              await client.models.generateImages({
                model: GOOGLE_LEGACY_IMAGE_MODEL,
                prompt:
                  "Create a small solid blue circle centered on a white background.",
                config: {
                  aspectRatio: "1:1",
                  numberOfImages: 1,
                  outputMimeType: "image/png",
                },
              });
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error ?? "");
            if (
              getRetryStatus(error) !== 404 &&
              !message.includes("only supported by the Gemini Enterprise")
            ) {
              throw error;
            }
          }
        },
      );

      await runOperation(
        "google-system-instruction-operation",
        "system-instruction",
        async () => {
          await withGoogleGenAIRetry(async () => {
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
          });
        },
      );

      await runOperation(
        "google-multi-turn-operation",
        "multi-turn",
        async () => {
          await withGoogleGenAIRetry(async () => {
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
          });
        },
      );

      await runOperation("google-embed-operation", "embed", async () => {
        await withGoogleGenAIRetry(async () => {
          await client.models.embedContent({
            model: GOOGLE_EMBEDDING_MODEL,
            contents: "Paris is the capital of France.",
          });
        });
      });

      await runMultimodalEmbeddings(client, imageBase64);

      if (options.includeInteractions) {
        await runOperation(
          "google-video-generate-operation",
          "video-generate",
          async () => {
            await withGoogleGenAIRetry(async () => {
              await client.interactions.create({
                model: GOOGLE_VIDEO_MODEL,
                input:
                  "A solid blue circle rotates once on a plain white background.",
                response_format: {
                  aspect_ratio: "16:9",
                  resolution: "360p",
                  type: "video",
                },
              });
            });
          },
        );

        await runOperation(
          "google-interaction-operation",
          "interaction",
          async () => {
            await withGoogleGenAIRetry(async () => {
              await client.interactions.create({
                model: GOOGLE_INTERACTIONS_MODEL,
                input: {
                  text: "Reply with exactly ROME.",
                  type: "text",
                },
                generation_config: {
                  max_output_tokens: 256,
                  thinking_level: "low",
                  temperature: 0,
                },
              });
            });
          },
        );

        await runOperation(
          "google-interaction-stream-operation",
          "interaction-stream",
          async () => {
            await withGoogleGenAIRetry(async () => {
              const stream = await client.interactions.create({
                model: GOOGLE_INTERACTIONS_MODEL,
                input: {
                  text: "Count from 1 to 3 and include the words one two three.",
                  type: "text",
                },
                generation_config: {
                  max_output_tokens: 256,
                  thinking_level: "low",
                  temperature: 0,
                },
                stream: true,
              });
              await collectAsync(stream);
            });
          },
        );

        let statefulInteractionId;
        await runOperation(
          "google-interaction-stateful-first-operation",
          "interaction-stateful-first",
          async () => {
            await withGoogleGenAIRetry(async () => {
              const interaction = await client.interactions.create({
                model: GOOGLE_INTERACTIONS_MODEL,
                input: {
                  text: "Hi, my name is Amir.",
                  type: "text",
                },
                generation_config: {
                  max_output_tokens: 256,
                  thinking_level: "low",
                  temperature: 0,
                },
              });
              statefulInteractionId = interaction.id;
            });
          },
        );

        if (!statefulInteractionId) {
          throw new Error("Missing stateful interaction id");
        }

        await runOperation(
          "google-interaction-stateful-second-operation",
          "interaction-stateful-second",
          async () => {
            await withGoogleGenAIRetry(async () => {
              await client.interactions.create({
                model: GOOGLE_INTERACTIONS_MODEL,
                input: {
                  text: "What is my name? Reply with exactly AMIR.",
                  type: "text",
                },
                previous_interaction_id: statefulInteractionId,
                generation_config: {
                  max_output_tokens: 256,
                  thinking_level: "low",
                  temperature: 0,
                },
              });
            });
          },
        );

        await runOperation(
          "google-interaction-background-operation",
          "interaction-background",
          async () => {
            try {
              await withGoogleGenAIRetry(async () => {
                await client.interactions.create({
                  model: GOOGLE_INTERACTIONS_MODEL,
                  input: {
                    text: "Reply with exactly BACKGROUND.",
                    type: "text",
                  },
                  background: true,
                  generation_config: {
                    max_output_tokens: 256,
                    thinking_level: "low",
                    temperature: 0,
                  },
                });
              });
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
      //   const chat = client.chats.create({
      //     model: GOOGLE_MODEL,
      //     config: {
      //       maxOutputTokens: 24,
      //       temperature: 0,
      //     },
      //   });

      //   await chat.sendMessage({
      //     message: "Reply with exactly MADRID.",
      //   });
      // });
      // await runOperation(
      //   "google-chat-stream-operation",
      //   "chat-stream",
      //   async () => {
      //     const chat = client.chats.create({
      //       model: GOOGLE_MODEL,
      //       config: {
      //         maxOutputTokens: 64,
      //         temperature: 0,
      //       },
      //     });

      //     const stream = await chat.sendMessageStream({
      //       message: "Count from 1 to 3 and include the words one two three.",
      //     });
      //     await collectAsync(stream);
      //   },
      // );

      await runOperation(
        "google-attachment-operation",
        "attachment",
        async () => {
          await withGoogleGenAIRetry(async () => {
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
        await withGoogleGenAIRetry(async () => {
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
          await withGoogleGenAIRetry(async () => {
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
          await withGoogleGenAIRetry(async () => {
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
          await withGoogleGenAIRetry(async () => {
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
        await withGoogleGenAIRetry(async () => {
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

      await runOperation(
        "google-multi-tool-operation",
        "multi-tool",
        async () => {
          await withGoogleGenAIRetry(async () => {
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
          });
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
  GOOGLE_EDIT_IMAGE_MODEL,
  GOOGLE_EMBEDDING_MODEL,
  GOOGLE_IMAGE_MODEL,
  GOOGLE_INTERACTIONS_MODEL,
  GOOGLE_LEGACY_IMAGE_MODEL,
  GOOGLE_MODEL,
  GOOGLE_VIDEO_MODEL,
  GOOGLE_VEO_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
};
