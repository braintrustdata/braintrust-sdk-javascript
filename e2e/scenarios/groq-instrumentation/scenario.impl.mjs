import { wrapGroq } from "braintrust";
import { readFile } from "node:fs/promises";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  AUDIO_MODEL,
  CHAT_MODEL,
  REASONING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
  TRANSLATION_MODEL,
} from "./constants.mjs";

export const GROQ_SCENARIO_TIMEOUT_MS = 120_000;

function getApiKey() {
  return process.env.GROQ_API_KEY;
}

async function getAudioFile() {
  const path = process.env.GROQ_AUDIO_FILE;
  if (!path) {
    throw new Error("Expected GROQ_AUDIO_FILE to be set for e2e");
  }
  return new File([await readFile(path)], "brooklyn_bridge.wav", {
    type: "audio/wav",
  });
}

function getWeatherToolDefinition() {
  return {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather for a city.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City name.",
          },
        },
        required: ["location"],
      },
    },
  };
}

export async function runGroqInstrumentationScenario(options) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Expected GROQ_API_KEY to be set for e2e");
  }

  const baseClient = new options.Groq({
    apiKey,
    baseURL: process.env.GROQ_BASE_URL,
  });
  const client = options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("groq-chat-operation", "chat", async () => {
        await client.chat.completions.create({
          max_completion_tokens: 64,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          model: CHAT_MODEL,
          temperature: 0,
        });
      });

      await runOperation("groq-stream-operation", "stream", async () => {
        const stream = await client.chat.completions.create({
          messages: [{ role: "user", content: "Reply with exactly STREAM." }],
          model: CHAT_MODEL,
          stream: true,
          temperature: 0,
        });
        await collectAsync(stream);
      });

      await runOperation(
        "groq-reasoning-stream-operation",
        "reasoning-stream",
        async () => {
          const stream = await client.chat.completions.create({
            max_completion_tokens: 512,
            messages: [
              {
                role: "user",
                content:
                  "Solve this step by step: Elena has 3 boxes with 4 marbles each, gives away 5 marbles, then doubles what remains. Reply with just the final number.",
              },
            ],
            model: REASONING_MODEL,
            reasoning_format: "parsed",
            stream: true,
            temperature: 0.6,
          });
          await collectAsync(stream);
        },
      );

      await runOperation("groq-tool-operation", "tool", async () => {
        await client.chat.completions.create({
          messages: [
            {
              role: "user",
              content: "Check the weather in Vienna and use the weather tool.",
            },
          ],
          model: CHAT_MODEL,
          temperature: 0,
          tool_choice: {
            type: "function",
            function: {
              name: "get_weather",
            },
          },
          tools: [getWeatherToolDefinition()],
        });
      });

      await runOperation(
        "groq-transcription-operation",
        "transcription",
        async () => {
          await client.audio.transcriptions.create({
            file: await getAudioFile(),
            language: "en",
            model: AUDIO_MODEL,
            response_format: "verbose_json",
            timestamp_granularities: ["word", "segment"],
          });
        },
      );

      await runOperation(
        "groq-translation-operation",
        "translation",
        async () => {
          await client.audio.translations.create({
            file: await getAudioFile(),
            model: TRANSLATION_MODEL,
            response_format: "json",
          });
        },
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-groq-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedGroqInstrumentation(options) {
  await runGroqInstrumentationScenario({
    decorateClient: wrapGroq,
    ...options,
  });
}

export async function runAutoGroqInstrumentation(options) {
  await runGroqInstrumentationScenario(options);
}
