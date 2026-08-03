import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { startSpan, wrapAnthropic } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const ANTHROPIC_MODEL = "claude-haiku-4-5";
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
const WEB_SEARCH_SERVER_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 1,
};

async function runAnthropicInstrumentationScenario(
  Anthropic,
  {
    decorateClient,
    useBetaMessages = true,
    supportsBetaToolRunner = true,
    supportsSessions = true,
    supportsThinking = false,
    supportsServerToolUse = true,
  } = {},
) {
  const imageBase64 = (
    await readFile(new URL("./test-image.png", import.meta.url))
  ).toString("base64");
  const baseClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });
  const client = decorateClient ? decorateClient(baseClient) : baseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("anthropic-create-operation", "create", async () => {
        await client.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 24,
          temperature: 0,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
        });
      });

      await runOperation(
        "anthropic-system-blocks-operation",
        "system-blocks",
        async () => {
          await client.messages.create({
            model: ANTHROPIC_MODEL,
            max_tokens: 24,
            temperature: 0,
            system: [
              { type: "text", text: "translate to english" },
              { type: "text", text: "remove all punctuation" },
              { type: "text", text: "only the answer no other text" },
            ],
            messages: [{ role: "user", content: "Bonjour mon ami!" }],
          });
        },
      );

      await runOperation(
        "anthropic-create-with-response-operation",
        "create-with-response",
        async () => {
          const response = await client.messages
            .create({
              model: ANTHROPIC_MODEL,
              max_tokens: 24,
              temperature: 0,
              messages: [
                {
                  role: "user",
                  content: "Reply with exactly WITH_RESPONSE.",
                },
              ],
            })
            .withResponse();
          void response.data;
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

      if (supportsServerToolUse) {
        await runOperation(
          "anthropic-server-tool-use-operation",
          "server-tool-use",
          async () => {
            await client.messages.create({
              model: "claude-sonnet-4-5-20250929",
              max_tokens: 256,
              temperature: 0,
              tools: [WEB_SEARCH_SERVER_TOOL],
              tool_choice: { type: "tool", name: WEB_SEARCH_SERVER_TOOL.name },
              messages: [
                {
                  role: "user",
                  content:
                    "Use web_search to find one recent AI SDK release headline and return one short sentence.",
                },
              ],
            });
          },
        );
      }

      if (supportsThinking) {
        await runOperation(
          "anthropic-stream-thinking-operation",
          "stream-thinking",
          async () => {
            const stream = await client.messages.create({
              model: "claude-sonnet-4-5-20250929",
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
              max_tokens: 24,
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

        await runOperation(
          "anthropic-beta-messages-stream-operation",
          "beta-messages-stream",
          async () => {
            const stream = client.beta.messages.stream({
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
          "anthropic-beta-stream-tool-operation",
          "beta-stream-tool",
          async () => {
            const stream = await client.beta.messages.create({
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

        if (supportsBetaToolRunner) {
          await runOperation(
            "anthropic-beta-tool-runner-operation",
            "beta-tool-runner",
            async () => {
              const finalMessage = await client.beta.messages.toolRunner({
                model: ANTHROPIC_MODEL,
                max_tokens: 128,
                max_iterations: 3,
                temperature: 0,
                tools: [
                  {
                    ...WEATHER_TOOL,
                    parse(input) {
                      return input;
                    },
                    run(input) {
                      const lookupSpan = startSpan({
                        name: "get_weather.lookup",
                      });
                      lookupSpan.end();
                      return `The weather in ${input.location} is 18C and sunny.`;
                    },
                  },
                ],
                messages: [
                  {
                    role: "user",
                    content:
                      "Use the get_weather tool exactly once for Paris, France. After you receive the tool result, reply with exactly that tool result text and do not call any tools again.",
                  },
                ],
              });
              void finalMessage.content;
            },
          );
        }

        if (supportsSessions) {
          await withManagedAgentsSessionServer(async (baseURL) => {
            const sessionsBaseClient = new Anthropic({
              apiKey: "anthropic-session-test-key",
              baseURL,
            });
            const sessionsClient = decorateClient
              ? decorateClient(sessionsBaseClient)
              : sessionsBaseClient;

            await runOperation(
              "anthropic-sessions-turn-operation",
              "sessions-turn",
              async () => {
                const stream = await sessionsClient.beta.sessions.events.stream(
                  "sesn_test",
                  { event_deltas: ["agent.message"] },
                );
                await collectAsync(stream);
              },
            );

            await runOperation(
              "anthropic-sessions-thread-turn-operation",
              "sessions-thread-turn",
              async () => {
                const stream =
                  await sessionsClient.beta.sessions.threads.events.stream(
                    "sthr_test",
                    { session_id: "sesn_test" },
                  );
                await collectAsync(stream);
              },
            );
          });
        }
      }
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-anthropic-instrumentation",
    rootName: ROOT_NAME,
  });
}

async function withManagedAgentsSessionServer(callback) {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    const events = request.url?.includes("/threads/")
      ? MANAGED_AGENTS_THREAD_EVENTS
      : MANAGED_AGENTS_EVENTS;
    for (const event of events) {
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Managed Agents test server did not bind to a TCP port");
  }

  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const MANAGED_AGENTS_EVENTS = [
  {
    id: "sevt_user",
    processed_at: "2026-08-03T00:00:00Z",
    type: "user.message",
    content: [{ type: "text", text: "Check the weather in Paris." }],
  },
  {
    id: "sevt_running",
    processed_at: "2026-08-03T00:00:01Z",
    type: "session.status_running",
  },
  {
    id: "sevt_model_start_1",
    processed_at: "2026-08-03T00:00:02Z",
    type: "span.model_request_start",
  },
  {
    id: "sevt_tool_use",
    processed_at: "2026-08-03T00:00:03Z",
    type: "agent.tool_use",
    name: "get_weather",
    input: { city: "Paris" },
    evaluated_permission: "allow",
  },
  {
    id: "sevt_model_end_1",
    processed_at: "2026-08-03T00:00:04Z",
    type: "span.model_request_end",
    model_request_start_id: "sevt_model_start_1",
    model_usage: {
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      input_tokens: 10,
      output_tokens: 3,
    },
    is_error: false,
  },
  {
    id: "sevt_tool_result",
    processed_at: "2026-08-03T00:00:05Z",
    type: "agent.tool_result",
    tool_use_id: "sevt_tool_use",
    content: [{ type: "text", text: "18C and sunny" }],
    is_error: false,
  },
  {
    id: "sevt_model_start_2",
    processed_at: "2026-08-03T00:00:06Z",
    type: "span.model_request_start",
  },
  {
    type: "event_delta",
    event_id: "sevt_message",
    delta: {
      type: "content_delta",
      index: 0,
      content: { type: "text", text: "It is" },
    },
  },
  {
    id: "sevt_message",
    processed_at: "2026-08-03T00:00:07Z",
    type: "agent.message",
    content: [{ type: "text", text: "It is 18C and sunny." }],
  },
  {
    id: "sevt_model_end_2",
    processed_at: "2026-08-03T00:00:08Z",
    type: "span.model_request_end",
    model_request_start_id: "sevt_model_start_2",
    model_usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 20,
      output_tokens: 4,
    },
    is_error: false,
  },
  {
    id: "sevt_idle",
    processed_at: "2026-08-03T00:00:09Z",
    type: "session.status_idle",
    stop_reason: { type: "end_turn" },
  },
];

const MANAGED_AGENTS_THREAD_EVENTS = MANAGED_AGENTS_EVENTS.map((event) => {
  if (event.type === "session.status_running") {
    return { ...event, type: "session.thread_status_running" };
  }
  if (event.type === "session.status_idle") {
    return { ...event, type: "session.thread_status_idle" };
  }
  return event;
});

export async function runWrappedAnthropicInstrumentation(Anthropic, options) {
  await runAnthropicInstrumentationScenario(Anthropic, {
    decorateClient: wrapAnthropic,
    ...options,
  });
}

export async function runAutoAnthropicInstrumentation(Anthropic, options) {
  await runAnthropicInstrumentationScenario(Anthropic, {
    ...options,
  });
}

export { ROOT_NAME, SCENARIO_NAME };
