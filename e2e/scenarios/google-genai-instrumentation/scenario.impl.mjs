import { readFile } from "node:fs/promises";
import { wrapGoogleGenAI } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const GOOGLE_MODEL = "gemini-2.5-flash-lite";
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
        await client.models.generateContent({
          model: GOOGLE_MODEL,
          contents: "Reply with exactly PARIS.",
          config: {
            maxOutputTokens: 16,
            temperature: 0,
          },
        });
      });

      await runOperation(
        "google-attachment-operation",
        "attachment",
        async () => {
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
              maxOutputTokens: 24,
              temperature: 0,
            },
          });
        },
      );

      await runOperation("google-stream-operation", "stream", async () => {
        const stream = await client.models.generateContentStream({
          model: GOOGLE_MODEL,
          contents: "Count from 1 to 3 and include the words one two three.",
          config: {
            maxOutputTokens: 32,
            temperature: 0,
          },
        });
        await collectAsync(stream);
      });

      await runOperation(
        "google-stream-return-operation",
        "stream-return",
        async () => {
          const stream = await client.models.generateContentStream({
            model: GOOGLE_MODEL,
            contents: "Reply with exactly BONJOUR.",
            config: {
              maxOutputTokens: 16,
              temperature: 0,
            },
          });

          for await (const _chunk of stream) {
            break;
          }
        },
      );

      await runOperation("google-tool-operation", "tool", async () => {
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

export { ROOT_NAME, SCENARIO_NAME };
