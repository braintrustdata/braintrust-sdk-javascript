import { readFile } from "node:fs/promises";
import { wrapAnthropic } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const ANTHROPIC_MODEL = "claude-3-haiku-20240307";
const ROOT_NAME = "anthropic-instrumentation-root";
const SCENARIO_NAME = "anthropic-instrumentation";
const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the current weather in a given location",
  input_schema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "The city and state or city and country",
      },
    },
    required: ["location"],
  },
};

async function runAnthropicInstrumentationScenario(
  Anthropic,
  {
    decorateClient,
    useBetaMessages = true,
    useMessagesStreamHelper = true,
    supportsThinking = false,
    // v0.11.0 of the orchestrion-js code transformer wraps promise-returning
    // functions via promise.then(), replacing the original APIPromise with a
    // plain Promise. This makes .withResponse() unavailable under auto-
    // instrumentation. Set to false when using the ESM hook or bundler plugins
    // until the transformer is updated to preserve the original return value.
    supportsWithResponse = true,
  } = {},
) {
  const imageBase64 = (
    await readFile(new URL("./test-image.png", import.meta.url))
  ).toString("base64");
  const baseClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  const client = decorateClient ? decorateClient(baseClient) : baseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("anthropic-create-operation", "create", async () => {
        await client.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
        });
      });

      await runOperation(
        "anthropic-create-with-response-operation",
        "create-with-response",
        async () => {
          const result = client.messages.create({
            model: ANTHROPIC_MODEL,
            max_tokens: 16,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: "Reply with exactly WITH_RESPONSE.",
              },
            ],
          });
          if (supportsWithResponse) {
            const response = await result.withResponse();
            void response.data;
          } else {
            await result;
          }
        },
      );

      await runOperation(
        "anthropic-attachment-operation",
        "attachment",
        async () => {
          await client.messages.create({
            model: ANTHROPIC_MODEL,
            max_tokens: 32,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Describe the attached image in one short sentence.",
                  },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: imageBase64,
                    },
                  },
                ],
              },
            ],
          });
        },
      );

      await runOperation("anthropic-stream-operation", "stream", async () => {
        const stream = await client.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 32,
          temperature: 0,
          stream: true,
          messages: [
            {
              role: "user",
              content: "Count from 1 to 3 and include the words one two three.",
            },
          ],
        });
        await collectAsync(stream);
      });

      await runOperation(
        "anthropic-stream-with-response-operation",
        "stream-with-response",
        async () => {
          const stream = client.messages.stream({
            model: ANTHROPIC_MODEL,
            max_tokens: 32,
            temperature: 0,
            messages: [
              {
                role: "user",
                content:
                  "Count from 1 to 3 and include the words one two three.",
              },
            ],
          });
          await collectAsync(stream);
        },
      );

      await runOperation(
        "anthropic-stream-tool-operation",
        "stream-tool",
        async () => {
          const stream = await client.messages.create({
            model: ANTHROPIC_MODEL,
            max_tokens: 128,
            temperature: 0,
            stream: true,
            tool_choice: {
              type: "tool",
              name: WEATHER_TOOL.name,
              disable_parallel_tool_use: true,
            },
            tools: [WEATHER_TOOL],
            messages: [
              {
                role: "user",
                content:
                  "Use the get_weather tool for Paris, France. Do not answer from memory.",
              },
            ],
          });
          await collectAsync(stream);
        },
      );

      await runOperation("anthropic-tool-operation", "tool", async () => {
        await client.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 128,
          temperature: 0,
          tools: [WEATHER_TOOL],
          messages: [
            {
              role: "user",
              content:
                "Use the get_weather tool for Paris, France. Do not answer from memory.",
            },
          ],
        });
      });

      if (supportsThinking) {
        await runOperation(
          "anthropic-stream-thinking-operation",
          "stream-thinking",
          async () => {
            const stream = await client.messages.create({
              model: "claude-sonnet-4-5",
              max_tokens: 2048,
              temperature: 1,
              thinking: {
                type: "enabled",
                budget_tokens: 1024,
              },
              stream: true,
              messages: [
                {
                  role: "user",
                  content: "What is 2+2? Reply with the number only.",
                },
              ],
            });
            await collectAsync(stream);
          },
        );
      }

      if (useBetaMessages) {
        await runOperation(
          "anthropic-beta-create-operation",
          "beta-create",
          async () => {
            await client.beta.messages.create({
              model: ANTHROPIC_MODEL,
              max_tokens: 16,
              temperature: 0,
              messages: [{ role: "user", content: "Reply with exactly BETA." }],
            });
          },
        );

        await runOperation(
          "anthropic-beta-stream-operation",
          "beta-stream",
          async () => {
            const stream = await client.beta.messages.create({
              model: ANTHROPIC_MODEL,
              max_tokens: 32,
              temperature: 0,
              stream: true,
              messages: [
                {
                  role: "user",
                  content:
                    "Count from 1 to 3 and include the words one two three.",
                },
              ],
            });
            await collectAsync(stream);
          },
        );
      }
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-anthropic-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedAnthropicInstrumentation(Anthropic, options) {
  await runAnthropicInstrumentationScenario(Anthropic, {
    decorateClient: wrapAnthropic,
    ...options,
  });
}

export async function runAutoAnthropicInstrumentation(Anthropic, options) {
  await runAnthropicInstrumentationScenario(Anthropic, {
    ...options,
    useMessagesStreamHelper: false,
    // The orchestrion-js v0.11.0 transformer wraps promise.then() around the
    // return value, replacing APIPromise with a plain Promise, which makes
    // .withResponse() unavailable under auto-instrumentation.
    supportsWithResponse: false,
  });
}

export { ROOT_NAME, SCENARIO_NAME };
