import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const OPENAI_MODEL = "gpt-4o-mini-2024-07-18";
const EMBEDDING_MODEL = "text-embedding-3-small";
const MODERATION_MODEL = "omni-moderation-2024-09-26";
const ROOT_NAME = "openai-instrumentation-root";
const SCENARIO_NAME = "openai-instrumentation";
const MOCK_CHAT_STREAM_SSE = [
  'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":1740000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"logprobs":null,"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":1740000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"refusal":"NO"},"logprobs":{"content":[{"token":"NO","logprob":-0.1,"bytes":[78,79],"top_logprobs":[{"token":"NO","logprob":-0.1,"bytes":[78,79]}]}]},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","created":1740000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"refusal":"PE"},"logprobs":{"content":[{"token":"PE","logprob":-0.2,"bytes":[80,69],"top_logprobs":[{"token":"PE","logprob":-0.2,"bytes":[80,69]}]}]},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const CHAT_PARSE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "number" },
  },
  required: ["answer"],
};

const RESPONSES_PARSE_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    value: { type: "integer" },
  },
  required: ["value", "reasoning"],
  additionalProperties: false,
};

async function collectOneAndReturn(stream) {
  for await (const _chunk of stream) {
    break;
  }
}

async function awaitMaybeWithResponse(request) {
  if (typeof request?.withResponse === "function") {
    return await request.withResponse();
  }

  return {
    data: await request,
  };
}

function parseMajorVersion(version) {
  if (typeof version !== "string") {
    return null;
  }

  const major = Number.parseInt(version.split(".")[0], 10);
  return Number.isNaN(major) ? null : major;
}

function createMockStreamingClient(options) {
  const baseClient = new options.OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? "test-openai-key",
    baseURL: "https://example.test/v1",
    fetch: async () =>
      new Response(MOCK_CHAT_STREAM_SSE, {
        headers: {
          "content-type": "text/event-stream",
        },
        status: 200,
      }),
  });

  return options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;
}

export async function runOpenAIInstrumentationScenario(options) {
  const baseClient = new options.OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  const client = options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;
  const streamFixtureClient = createMockStreamingClient(options);
  const openAIMajorVersion = parseMajorVersion(options.openaiSdkVersion);
  const shouldCheckPrivateFieldMethods =
    typeof options.decorateClient === "function" &&
    openAIMajorVersion !== null &&
    openAIMajorVersion >= 6;

  await runTracedScenario({
    callback: async () => {
      if (shouldCheckPrivateFieldMethods) {
        await runOperation(
          "openai-client-private-fields-operation",
          "client-private-fields",
          async () => {
            if (
              typeof client.buildURL !== "function" ||
              typeof client.buildRequest !== "function"
            ) {
              throw new Error(
                "Expected wrapped OpenAI v6 client to expose buildURL and buildRequest",
              );
            }

            const builtUrl = client.buildURL("/files", null);
            if (typeof builtUrl !== "string" || !builtUrl.includes("/files")) {
              throw new Error(
                `Unexpected buildURL result: ${String(builtUrl)}`,
              );
            }

            const builtRequest = await client.buildRequest(
              { method: "post", path: "/files" },
              { retryCount: 0 },
            );
            if (
              typeof builtRequest?.url !== "string" ||
              !builtRequest.url.includes("/files")
            ) {
              throw new Error(
                `Unexpected buildRequest result: ${String(builtRequest?.url)}`,
              );
            }
          },
        );
      }

      await runOperation("openai-chat-operation", "chat", async () => {
        await client.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          max_tokens: 12,
          temperature: 0,
        });
      });

      await runOperation(
        "openai-chat-with-response-operation",
        "chat-with-response",
        async () => {
          await awaitMaybeWithResponse(
            client.chat.completions.create({
              model: OPENAI_MODEL,
              messages: [{ role: "user", content: "Reply with exactly FOUR." }],
              max_tokens: 12,
              temperature: 0,
            }),
          );
        },
      );

      await runOperation("openai-stream-operation", "stream", async () => {
        const chatStream = await client.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: "Reply with exactly STREAM." }],
          stream: true,
          max_tokens: 12,
          temperature: 0,
          stream_options: {
            include_usage: true,
          },
        });
        await collectAsync(chatStream);
      });

      await runOperation(
        "openai-stream-with-response-operation",
        "stream-with-response",
        async () => {
          const { data: chatStream } = await awaitMaybeWithResponse(
            client.chat.completions.create({
              model: OPENAI_MODEL,
              messages: [
                {
                  role: "user",
                  content: "Reply with exactly STREAM-WITH-RESPONSE.",
                },
              ],
              stream: true,
              max_tokens: 24,
              temperature: 0,
              stream_options: {
                include_usage: true,
              },
            }),
          );
          await collectAsync(chatStream);
        },
      );

      await runOperation(
        "openai-stream-fixture-operation",
        "stream-fixture",
        async () => {
          const chatStream = await streamFixtureClient.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
              {
                role: "user",
                content: "Reply with a refusal stream fixture.",
              },
            ],
            stream: true,
            logprobs: true,
            top_logprobs: 2,
            max_tokens: 12,
            temperature: 0,
          });
          await collectAsync(chatStream);
        },
      );

      await runOperation("openai-parse-operation", "parse", async () => {
        const parseArgs = {
          messages: [{ role: "user", content: "What is 2 + 2?" }],
          model: OPENAI_MODEL,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "math_response",
              schema: CHAT_PARSE_SCHEMA,
            },
          },
        };

        if (options.useChatParseHelper === false) {
          await client.chat.completions.create(parseArgs);
        } else if (options.chatHelperNamespace === "beta") {
          await client.beta.chat.completions.parse(parseArgs);
        } else {
          await client.chat.completions.parse(parseArgs);
        }
      });

      await runOperation(
        "openai-sync-stream-operation",
        "sync-stream",
        async () => {
          const streamArgs = {
            model: OPENAI_MODEL,
            messages: [
              { role: "user", content: "Reply with exactly SYNC STREAM." },
            ],
            max_tokens: 24,
            temperature: 0,
          };

          if (options.useSyncStreamHelper === false) {
            const stream = await client.chat.completions.create({
              ...streamArgs,
              stream: true,
              stream_options: {
                include_usage: true,
              },
            });
            await collectAsync(stream);
          } else {
            const runner =
              options.chatHelperNamespace === "beta"
                ? client.beta.chat.completions.stream(streamArgs)
                : client.chat.completions.stream(streamArgs);
            await runner.finalChatCompletion();
          }
        },
      );

      await runOperation(
        "openai-embeddings-operation",
        "embeddings",
        async () => {
          await client.embeddings.create({
            model: EMBEDDING_MODEL,
            input: "Paris",
          });
        },
      );

      await runOperation(
        "openai-moderations-operation",
        "moderations",
        async () => {
          await client.moderations.create({
            model: MODERATION_MODEL,
            input: "Hello from Braintrust.",
          });
        },
      );

      await runOperation(
        "openai-responses-operation",
        "responses",
        async () => {
          await client.responses.create({
            model: OPENAI_MODEL,
            input: "Reply with exactly PARIS.",
            max_output_tokens: 24,
          });
        },
      );

      await runOperation(
        "openai-responses-with-response-operation",
        "responses-with-response",
        async () => {
          await awaitMaybeWithResponse(
            client.responses.create({
              model: OPENAI_MODEL,
              input: "What is 2 + 2? Reply with just the number.",
              max_output_tokens: 24,
            }),
          );
        },
      );

      await runOperation(
        "openai-responses-create-stream-operation",
        "responses-create-stream",
        async () => {
          const { data: responseStream } = await awaitMaybeWithResponse(
            client.responses.create({
              model: OPENAI_MODEL,
              input: "Reply with exactly RESPONSE STREAM.",
              max_output_tokens: 24,
              stream: true,
            }),
          );
          await collectAsync(responseStream);
        },
      );

      await runOperation(
        "openai-responses-stream-operation",
        "responses-stream",
        async () => {
          const stream = client.responses.stream({
            model: OPENAI_MODEL,
            input: "What is 6 x 6? Reply with just the number.",
            max_output_tokens: 24,
          });
          await collectAsync(stream);
          await stream.finalResponse();
        },
      );

      await runOperation(
        "openai-responses-stream-partial-operation",
        "responses-stream-partial",
        async () => {
          const stream = client.responses.stream({
            model: OPENAI_MODEL,
            input: "Reply with exactly PARTIAL.",
            max_output_tokens: 24,
          });
          await collectOneAndReturn(stream);
        },
      );

      await runOperation(
        "openai-responses-parse-operation",
        "responses-parse",
        async () => {
          const parseArgs = {
            model: OPENAI_MODEL,
            input: "What is 20 + 4?",
            text: {
              format: {
                name: "NumberAnswer",
                type: "json_schema",
                schema: RESPONSES_PARSE_SCHEMA,
              },
            },
          };

          if (options.useResponsesParseHelper === false) {
            await client.responses.create(parseArgs);
          } else {
            await client.responses.parse(parseArgs);
          }
        },
      );

      if (typeof client.responses?.compact === "function") {
        await runOperation(
          "openai-responses-compact-operation",
          "responses-compact",
          async () => {
            await client.responses.compact({
              model: OPENAI_MODEL,
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: "I live in Paris and prefer concise answers.",
                    },
                  ],
                },
                {
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "Understood. I will keep answers concise.",
                    },
                  ],
                },
              ],
              instructions: "Preserve only durable user preferences.",
            });
          },
        );
      }
    },
    metadata: {
      openaiSdkVersion: options.openaiSdkVersion,
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-openai-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runAutoOpenAIInstrumentation(
  OpenAI,
  { chatHelperNamespace, openaiSdkVersion },
) {
  await runOpenAIInstrumentationScenario({
    OpenAI,
    chatHelperNamespace,
    openaiSdkVersion,
    useChatParseHelper: false,
    useResponsesParseHelper: false,
    useSyncStreamHelper: false,
  });
}

export { ROOT_NAME, SCENARIO_NAME };
