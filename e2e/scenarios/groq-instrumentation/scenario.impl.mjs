import { wrapGroq } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import { CHAT_MODEL, ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

export const GROQ_SCENARIO_TIMEOUT_MS = 120_000;

function getApiKey() {
  return process.env.GROQ_API_KEY;
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
  });
  const client = options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("groq-chat-operation", "chat", async () => {
        await client.chat.completions.create({
          max_completion_tokens: 12,
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
