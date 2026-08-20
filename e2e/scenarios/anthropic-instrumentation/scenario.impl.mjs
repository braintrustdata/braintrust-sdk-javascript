import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  bindAnthropicBatchTrace,
  collectAnthropicSession,
  completeAnthropicBatchTrace,
  failAnthropicBatchTrace,
  startAnthropicBatchTrace,
  startSpan,
  wrapAnthropic,
} from "braintrust";
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

function createMockBatchClient(Anthropic, decorateClient) {
  const baseClient = new Anthropic({
    apiKey: "anthropic-batch-test-key",
    baseURL: "https://example.test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          cancel_initiated_at: null,
          created_at: new Date().toISOString(),
          ended_at: null,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          id: "msgbatch_e2e",
          processing_status: "in_progress",
          request_counts: {
            canceled: 0,
            errored: 0,
            expired: 0,
            processing: 3,
            succeeded: 0,
          },
          results_url: null,
          type: "message_batch",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      ),
  });

  return decorateClient ? decorateClient(baseClient) : baseClient;
}

async function runAnthropicInstrumentationScenario(
  Anthropic,
  {
    decorateClient,
    supportsBatches = false,
    useBetaMessages = true,
    supportsBetaMessagesStream = true,
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
  const batchClient = supportsBatches
    ? createMockBatchClient(Anthropic, decorateClient)
    : undefined;

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

      if (supportsBatches) {
        await runOperation("anthropic-batch-operation", "batch", async () => {
          const started = await startAnthropicBatchTrace({
            params: {
              requests: [
                {
                  custom_id: "batch-success-one",
                  params: {
                    max_tokens: 24,
                    messages: [{ role: "user", content: "Reply with ONE." }],
                    model: ANTHROPIC_MODEL,
                    system: "Reply with only the requested word.",
                  },
                },
                {
                  custom_id: "batch-error",
                  params: {
                    max_tokens: 24,
                    messages: [{ role: "user", content: "Fail this request." }],
                    model: ANTHROPIC_MODEL,
                  },
                },
                {
                  custom_id: "batch-success-two",
                  params: {
                    max_tokens: 24,
                    messages: [{ role: "user", content: "Reply with TWO." }],
                    model: ANTHROPIC_MODEL,
                  },
                },
              ],
            },
          });

          let batch;
          try {
            batch = await batchClient.messages.batches.create(started.params);
          } catch (error) {
            if (started.traceContext) {
              await failAnthropicBatchTrace({
                error,
                params: started.params,
                traceContext: started.traceContext,
              });
            }
            throw error;
          }
          const traceContext = await bindAnthropicBatchTrace({
            batch,
            traceContext: started.traceContext,
          });

          async function* results() {
            yield {
              custom_id: "batch-success-two",
              result: {
                message: {
                  content: [{ text: "TWO", type: "text" }],
                  id: "msg_batch_two",
                  model: ANTHROPIC_MODEL,
                  role: "assistant",
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  type: "message",
                  usage: {
                    cache_creation_input_tokens: 1,
                    cache_read_input_tokens: 2,
                    input_tokens: 3,
                    output_tokens: 4,
                  },
                },
                type: "succeeded",
              },
            };
            yield {
              custom_id: "batch-error",
              result: {
                error: {
                  error: {
                    message: "Synthetic Anthropic batch request failure",
                    type: "invalid_request_error",
                  },
                  type: "error",
                },
                type: "errored",
              },
            };
            yield {
              custom_id: "batch-success-one",
              result: {
                message: {
                  content: [{ text: "ONE", type: "text" }],
                  id: "msg_batch_one",
                  model: "claude-haiku-4-5-resolved",
                  role: "assistant",
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  type: "message",
                  usage: {
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    input_tokens: 5,
                    output_tokens: 2,
                  },
                },
                type: "succeeded",
              },
            };
          }

          await completeAnthropicBatchTrace({
            batch: {
              ...batch,
              ended_at: new Date(Date.now() + 1000).toISOString(),
              processing_status: "ended",
              request_counts: {
                canceled: 0,
                errored: 1,
                expired: 0,
                processing: 0,
                succeeded: 2,
              },
            },
            params: started.params,
            results: results(),
            traceContext,
          });
        });
      }

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

        if (supportsBetaMessagesStream) {
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
        }

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
            const sessions = sessionsClient.beta.sessions;

            await runOperation(
              "anthropic-sessions-turn-operation",
              "sessions-turn",
              async () => {
                const stream = collectAnthropicSession(
                  await sessions.events.stream("sesn_test", {
                    event_deltas: ["agent.message"],
                  }),
                );
                await collectAsync(stream);
              },
            );

            await runOperation(
              "anthropic-sessions-uncollected-operation",
              "sessions-uncollected",
              async () => {
                const stream = await sessions.events.stream(
                  "sesn_uncollected",
                  { event_deltas: ["agent.message"] },
                );
                await collectAsync(stream);
              },
            );

            await runOperation(
              "anthropic-sessions-thread-turn-operation",
              "sessions-thread-turn",
              async () => {
                const stream = collectAnthropicSession(
                  await sessions.threads.events.stream("sthr_test", {
                    session_id: "sesn_test",
                  }),
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
