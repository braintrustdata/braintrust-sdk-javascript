import {
  completeGroqBatchTrace,
  groqBatchesCreateTraced,
  groqBatchesRetrieveTraced,
  groqFilesCreateTraced,
  wrapGroq,
} from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  CHAT_MODEL,
  REASONING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

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

function createMockBatchClient(options) {
  let createdBatch;
  const baseClient = new options.Groq({
    apiKey: "test-groq-key",
    baseURL: "https://example.test",
    maxRetries: 0,
    fetch: async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/files")) {
        return new Response(
          JSON.stringify({
            id: "file_groq_batch_fixture",
            object: "file",
            purpose: "batch",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }
      if (pathname.endsWith("/batches/batch_groq_e2e_fixture")) {
        return new Response(
          JSON.stringify({
            ...createdBatch,
            status: "completed",
            completed_at: Date.now() / 1000 + 60,
            request_counts: { completed: 2, failed: 1, total: 3 },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }
      const params = JSON.parse(String(init?.body));
      createdBatch = {
        id: "batch_groq_e2e_fixture",
        object: "batch",
        endpoint: params.endpoint,
        input_file_id: params.input_file_id,
        completion_window: params.completion_window,
        status: "validating",
        created_at: 1_740_000_000,
        metadata: params.metadata,
        request_counts: { completed: 0, failed: 0, total: 0 },
      };
      return new Response(JSON.stringify(createdBatch), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });
  return options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;
}

function batchInput(items) {
  return items
    .map((item) =>
      JSON.stringify({
        custom_id: item.customId,
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model: CHAT_MODEL,
          messages: [{ role: "user", content: item.prompt }],
          temperature: 0,
        },
      }),
    )
    .join("\n");
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
  const batchFixtureClient = createMockBatchClient(options);

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

      await runOperation("groq-batch-operation", "batch", async () => {
        const items = [
          { customId: "batch_alpha", prompt: "Reply with ALPHA." },
          { customId: "batch_bravo", prompt: "Reply with BRAVO." },
          { customId: "batch_error", prompt: "This request should fail." },
        ];
        const input = batchInput(items);
        const inputFile = await groqFilesCreateTraced(batchFixtureClient.files)(
          {
            file: new Blob([input]),
            purpose: "batch",
          },
        );
        const createdBatch = await groqBatchesCreateTraced(
          batchFixtureClient.batches,
        )({
          completion_window: "48h",
          endpoint: "/v1/chat/completions",
          input_file_id: inputFile.id,
        });
        const completedBatch = await groqBatchesRetrieveTraced(
          batchFixtureClient.batches,
        )(createdBatch.id);
        const outputFile = Promise.resolve(
          new Response(
            [items[1], items[0]]
              .map((item, index) =>
                JSON.stringify({
                  custom_id: item.customId,
                  response: {
                    status_code: 200,
                    body: {
                      model: CHAT_MODEL,
                      choices: [
                        {
                          index: 0,
                          finish_reason: "stop",
                          message: {
                            role: "assistant",
                            content: index === 0 ? "BRAVO" : "ALPHA",
                          },
                        },
                      ],
                      usage: {
                        prompt_tokens: 5,
                        completion_tokens: 1,
                        total_tokens: 6,
                      },
                      x_groq: {
                        usage: {
                          dram_cached_tokens: 2,
                          sram_cached_tokens: 1,
                        },
                      },
                    },
                  },
                }),
              )
              .join("\n"),
          ),
        );
        const errorFile = Promise.resolve(
          new Response(
            JSON.stringify({
              custom_id: items[2].customId,
              error: { message: "Groq batch fixture request failed" },
            }),
          ),
        );
        await completeGroqBatchTrace({
          batch: completedBatch,
          inputFileContent: input,
          outputFileContent: outputFile,
          errorFileContent: errorFile,
        });
        if (!(await outputFile).bodyUsed || !(await errorFile).bodyUsed) {
          throw new Error(
            "Expected Groq batch result responses to be consumed",
          );
        }
      });

      await runOperation(
        "groq-batch-collect-only-operation",
        "batch-collect-only",
        async () => {
          const items = [
            { customId: "collect_only", prompt: "Collect this response." },
          ];
          const input = batchInput(items);
          const completedAt = Date.now() / 1000;
          await completeGroqBatchTrace({
            batch: {
              id: "batch_groq_collect_only_fixture",
              endpoint: "/v1/chat/completions",
              input_file_id: "file_groq_collect_only_fixture",
              status: "completed",
              created_at: completedAt,
              completed_at: completedAt,
              request_counts: { completed: 1, failed: 0, total: 1 },
            },
            inputFileContent: input,
            outputFileContent: new Response(
              JSON.stringify({
                custom_id: items[0].customId,
                response: {
                  status_code: 200,
                  body: {
                    model: CHAT_MODEL,
                    choices: [
                      {
                        index: 0,
                        finish_reason: "stop",
                        message: {
                          role: "assistant",
                          content: "COLLECTED",
                        },
                      },
                    ],
                    usage: {
                      prompt_tokens: 4,
                      completion_tokens: 1,
                      total_tokens: 5,
                    },
                  },
                },
              }),
            ),
          });
        },
      );

      await runOperation(
        "groq-batch-submission-failure-operation",
        "batch-submission-failure",
        async () => {
          const items = [
            { customId: "submission_one", prompt: "First pending request." },
            { customId: "submission_two", prompt: "Second pending request." },
          ];
          const input = batchInput(items);
          const inputFile = await groqFilesCreateTraced(
            batchFixtureClient.files,
          )({ file: new Blob([input]), purpose: "batch" });
          const rejectedBatches = {
            create() {
              const promise = Promise.reject(
                new Error("Groq batch submission failed"),
              );
              promise.withResponse = () => promise;
              promise.asResponse = () => promise;
              return promise;
            },
          };
          try {
            await groqBatchesCreateTraced(rejectedBatches)({
              completion_window: "24h",
              endpoint: "/v1/chat/completions",
              input_file_id: inputFile.id,
            });
          } catch {
            // Submission failures are recorded by the traced create wrapper.
          }
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
