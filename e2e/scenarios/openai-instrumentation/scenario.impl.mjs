import {
  MINIMAL_PDF_BASE64,
  MINIMAL_PNG_BASE64,
} from "../../helpers/media-fixtures.mjs";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  completeOpenAIBatchTrace,
  openaiBatchesRetrieveTraced,
  openaiFilesCreateTraced,
} from "braintrust";
import { once } from "node:events";
import { Writable } from "node:stream";

const OPENAI_MODEL = "gpt-4o-mini-2024-07-18";
const OPENAI_IMAGE_MODEL = "gpt-image-2";
const EMBEDDING_MODEL = "text-embedding-3-small";
const MODERATION_MODEL = "omni-moderation-2024-09-26";
const ROOT_NAME = "openai-instrumentation-root";
const SCENARIO_NAME = "openai-instrumentation";
const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather for a location",
      parameters: {
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
  },
];
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
const MOCK_CHAT_MULTIPLE_CHOICES_STREAM_SSE = [
  'data: {"id":"chatcmpl-multiple-choices-fixture","object":"chat.completion.chunk","created":1740000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"choice_0_call_0","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Bos"}},{"index":1,"id":"choice_0_call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Par"}}]},"logprobs":null,"finish_reason":null},{"index":1,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"choice_1_call_0","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Tok"}},{"index":1,"id":"choice_1_call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Ro"}}]},"logprobs":null,"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-multiple-choices-fixture","object":"chat.completion.chunk","created":1740000000,"model":"gpt-4o-mini","choices":[{"index":1,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"me\\"}"}},{"index":0,"function":{"arguments":"yo\\"}"}}]},"logprobs":null,"finish_reason":"tool_calls"},{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"is\\"}"}},{"index":0,"function":{"arguments":"ton\\"}"}}]},"logprobs":null,"finish_reason":"tool_calls"}]}',
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

function createMockStreamingClient(options, responseBody) {
  const baseClient = new options.OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? "test-openai-key",
    baseURL: "https://example.test/v1",
    fetch: async () =>
      new Response(responseBody, {
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

function createMockBatchClient(options) {
  const batchCreatedAt = Date.now() / 1000;
  const baseClient = new options.OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? "test-openai-key",
    baseURL: "https://example.test/v1",
    fetch: async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/files")) {
        return new Response(
          JSON.stringify({
            id: "file_batch_e2e_fixture",
            object: "file",
            bytes: 1024,
            created_at: batchCreatedAt,
            filename: "batch.jsonl",
            purpose: "batch",
            status: "processed",
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_file_batch_e2e_fixture",
            },
            status: 200,
          },
        );
      }

      if (pathname.endsWith("/batches/batch_e2e_fixture")) {
        return new Response(
          JSON.stringify({
            id: "batch_e2e_fixture",
            object: "batch",
            endpoint: "/v1/chat/completions",
            input_file_id: "file_batch_e2e_fixture",
            completion_window: "24h",
            status: "completed",
            created_at: batchCreatedAt,
            in_progress_at: batchCreatedAt + 1,
            completed_at: batchCreatedAt + 2,
            request_counts: { completed: 2, failed: 1, total: 3 },
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_batch_e2e_fixture",
            },
            status: 200,
          },
        );
      }

      const params = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "batch_e2e_fixture",
          object: "batch",
          endpoint: params.endpoint,
          input_file_id: params.input_file_id,
          completion_window: params.completion_window,
          status: "validating",
          created_at: 1_740_000_000,
          metadata: params.metadata,
          request_counts: { completed: 0, failed: 0, total: 0 },
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_batch_e2e_fixture",
          },
          status: 200,
        },
      );
    },
  });

  return options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;
}

async function runOpenAIMediaOperations(client, openAIMajorVersion) {
  const inputImage = new File(
    [Buffer.from(MINIMAL_PNG_BASE64, "base64")],
    "input.png",
    { type: "image/png" },
  );

  await runOperation(
    "openai-images-generate-operation",
    "images-generate",
    async () => {
      const request = client.images.generate({
        model: OPENAI_IMAGE_MODEL,
        prompt: "A plain red square on white.",
        n: 2,
        size: "1024x1024",
        quality: "low",
      });
      if (typeof request.withResponse !== "function") {
        throw new Error("Expected image generation to return an APIPromise");
      }
      const generation = await request.withResponse();
      if (generation.data.data.length !== 2) {
        throw new Error("Expected two generated images");
      }
      if ((await request.asResponse()) !== generation.response) {
        throw new Error(
          "Expected APIPromise response identity to be preserved",
        );
      }
    },
  );

  await runOperation(
    "openai-images-edit-operation",
    "images-edit",
    async () => {
      const edited = await client.images.edit({
        model: OPENAI_IMAGE_MODEL,
        image: inputImage,
        prompt: "Make a plain blue square on white.",
        size: "1024x1024",
        quality: "low",
      });
      if (!edited.data[0]?.b64_json) {
        throw new Error("Expected an edited image");
      }
    },
  );

  await runOperation(
    "openai-images-variation-operation",
    "images-variation",
    async () => {
      try {
        await client.images.createVariation({
          model: "dall-e-2",
          image: inputImage,
        });
      } catch (error) {
        if (error?.status >= 400 && error.status < 500) {
          return;
        }
        throw error;
      }
      throw new Error("Expected the retired image variation endpoint to fail");
    },
  );

  if (openAIMajorVersion >= 5) {
    for (const operation of ["generate", "edit"]) {
      await runOperation(
        `openai-images-${operation}-stream-operation`,
        `images-${operation}-stream`,
        async () => {
          const stream = await client.images[operation]({
            model: OPENAI_IMAGE_MODEL,
            ...(operation === "edit" ? { image: inputImage } : {}),
            prompt: "A plain green square on white.",
            size: "1024x1024",
            quality: "low",
            stream: true,
            partial_images: 1,
          });
          const events = await collectAsync(stream);
          if (
            !events.some(
              (event) =>
                event.type.endsWith(".completed") && Boolean(event.b64_json),
            )
          ) {
            throw new Error(`Expected streamed image ${operation} output`);
          }
        },
      );
    }
  }

  let transcriptionWav;
  await runOperation(
    "openai-audio-speech-operation",
    "audio-speech",
    async () => {
      const speech = await client.audio.speech.create({
        model: "gpt-4o-mini-tts",
        input: "Hello.",
        voice: "coral",
        response_format: "wav",
      });
      if (speech.bodyUsed) {
        throw new Error("Expected an unread speech response");
      }
      const wav = Buffer.from(await speech.arrayBuffer());
      if (wav.toString("ascii", 0, 4) !== "RIFF") {
        throw new Error("Expected a WAV speech response");
      }
      let pcm;
      for (let offset = 12; offset + 8 <= wav.length; ) {
        const length = wav.readUInt32LE(offset + 4);
        if (wav.toString("ascii", offset, offset + 4) === "data") {
          pcm = wav.subarray(offset + 8);
          break;
        }
        offset += 8 + length + (length % 2);
      }
      if (
        !pcm?.length ||
        wav.readUInt16LE(20) !== 1 ||
        wav.readUInt16LE(22) !== 1 ||
        wav.readUInt32LE(24) !== 24_000
      ) {
        throw new Error("Expected 24 kHz mono PCM speech audio");
      }
      transcriptionWav = Buffer.alloc(44 + Math.floor(pcm.length / 4) * 2);
      wav.copy(transcriptionWav, 0, 0, 44);
      transcriptionWav.writeUInt32LE(transcriptionWav.length - 8, 4);
      transcriptionWav.writeUInt32LE(12_000, 24);
      transcriptionWav.writeUInt32LE(24_000, 28);
      transcriptionWav.writeUInt32LE(transcriptionWav.length - 44, 40);
      for (let offset = 0; offset < transcriptionWav.length - 44; offset += 2) {
        transcriptionWav.writeInt16LE(pcm.readInt16LE(offset * 2), 44 + offset);
      }
      if (transcriptionWav.length >= 60_000) {
        throw new Error("Expected a cassette-safe transcription fixture");
      }
    },
  );

  const inputAudio = new File([transcriptionWav], "hello.wav", {
    type: "audio/wav",
  });
  await runOperation(
    "openai-audio-transcription-operation",
    "audio-transcription",
    async () => {
      const transcript = await client.audio.transcriptions.create({
        model: "gpt-4o-transcribe",
        file: inputAudio,
        language: "en",
      });
      if (!transcript.text.trim()) {
        throw new Error("Expected transcription text");
      }
    },
  );

  await runOperation(
    "openai-audio-transcription-stream-operation",
    "audio-transcription-stream",
    async () => {
      const stream = await client.audio.transcriptions.create({
        model: "gpt-4o-transcribe",
        file: inputAudio,
        stream: true,
      });
      const events = await collectAsync(stream);
      if (
        !events.some(
          (event) =>
            event.type === "transcript.text.done" && Boolean(event.text.trim()),
        )
      ) {
        throw new Error("Expected completed streamed transcription text");
      }
    },
  );

  await runOperation(
    "openai-audio-translation-operation",
    "audio-translation",
    async () => {
      const translation = await client.audio.translations.create({
        model: "whisper-1",
        file: inputAudio,
      });
      if (!translation.text.trim()) {
        throw new Error("Expected translated text");
      }
    },
  );

  for (const read of ["reader", "iterate", "pipe", "cancel", "unread"]) {
    await runOperation(
      `openai-audio-speech-${read}-operation`,
      `audio-speech-${read}`,
      async () => {
        const response = await client.audio.speech.create({
          model: "gpt-4o-mini-tts",
          input: `Hello ${read}.`,
          voice: "coral",
        });
        if (response.bodyUsed) {
          throw new Error("Expected an unread speech response");
        }
        let size = 0;
        if (
          read === "reader" &&
          typeof response.body.getReader === "function"
        ) {
          const reader = response.body.getReader();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
          }
        }
        if (
          read === "iterate" ||
          (read === "reader" && typeof response.body.getReader !== "function")
        ) {
          for await (const chunk of response.body) size += chunk.byteLength;
        }
        if (read === "pipe" && typeof response.body.pipeTo === "function") {
          await response.body.pipeTo(
            new WritableStream({
              write(chunk) {
                size += chunk.byteLength;
              },
            }),
          );
        }
        if (read === "pipe" && typeof response.body.pipeTo !== "function") {
          const destination = new Writable({
            write(chunk, _encoding, callback) {
              size += chunk.length;
              callback();
            },
          });
          const finished = once(destination, "finish");
          response.body.pipe(destination);
          await finished;
        }
        if (read === "cancel") {
          if (typeof response.body.cancel === "function") {
            await response.body.cancel();
          } else {
            response.body.destroy();
          }
        }
        if (!["cancel", "unread"].includes(read) && size === 0) {
          throw new Error(`Expected speech bytes consumed through ${read}`);
        }
      },
    );
  }

  await runOperation(
    "openai-audio-speech-sse-operation",
    "audio-speech-sse",
    async () => {
      const response = await client.audio.speech.create({
        model: "gpt-4o-mini-tts",
        input: "Hello streaming.",
        voice: "coral",
        stream_format: "sse",
      });
      let size = 0;
      for await (const chunk of response.body) size += chunk.byteLength;
      if (size === 0) {
        throw new Error("Expected streamed speech audio");
      }
    },
  );
}

export async function runOpenAIInstrumentationScenario(options) {
  const baseClient = new options.OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    maxRetries: 0,
    timeout: 180_000,
  });
  const client = options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;
  const streamFixtureClient = createMockStreamingClient(
    options,
    MOCK_CHAT_STREAM_SSE,
  );
  const multipleChoicesStreamFixtureClient = createMockStreamingClient(
    options,
    MOCK_CHAT_MULTIPLE_CHOICES_STREAM_SSE,
  );
  const batchFixtureClient = createMockBatchClient(options);
  const openAIMajorVersion = parseMajorVersion(options.openaiSdkVersion);
  const shouldCheckPrivateFieldMethods =
    typeof options.decorateClient === "function" &&
    openAIMajorVersion !== null &&
    openAIMajorVersion >= 6;
  const supportsChatAttachments =
    openAIMajorVersion !== null && openAIMajorVersion >= 6;

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
          const request = client.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [{ role: "user", content: "Reply with exactly FOUR." }],
            max_tokens: 12,
            temperature: 0,
          });
          const { data, response } = await awaitMaybeWithResponse(request);
          if (response && response.status !== 200) {
            throw new Error(`Expected status 200, got ${response.status}`);
          }
          if (typeof request?.withResponse === "function") {
            const dataOnly = await request;
            if (dataOnly !== data) {
              throw new Error(
                "Expected direct await to return cached withResponse data",
              );
            }
          }
        },
      );

      if (supportsChatAttachments) {
        await runOperation(
          "openai-chat-image-attachment-operation",
          "chat-image-attachment",
          async () => {
            await client.chat.completions.create({
              model: OPENAI_MODEL,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "Describe this image in three words or fewer.",
                    },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:image/png;base64,${MINIMAL_PNG_BASE64}`,
                      },
                    },
                  ],
                },
              ],
              max_tokens: 24,
              temperature: 0,
            });
          },
        );

        await runOperation(
          "openai-chat-pdf-attachment-operation",
          "chat-pdf-attachment",
          async () => {
            await client.chat.completions.create({
              model: OPENAI_MODEL,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "Summarize this document in one short phrase.",
                    },
                    {
                      type: "file",
                      file: {
                        file_data: `data:application/pdf;base64,${MINIMAL_PDF_BASE64}`,
                        filename: "document.pdf",
                      },
                    },
                  ],
                },
              ],
              max_tokens: 24,
              temperature: 0,
            });
          },
        );
      }

      await runOperation(
        "openai-chat-tool-operation",
        "chat-tool",
        async () => {
          await client.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
              {
                role: "user",
                content:
                  "Use the get_weather tool for Paris, France. Do not answer from memory.",
              },
            ],
            max_tokens: 64,
            temperature: 0,
            tool_choice: {
              type: "function",
              function: { name: "get_weather" },
            },
            tools: CHAT_TOOLS,
          });
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
          const request = client.chat.completions.create({
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
          });
          const { data: chatStream, response } =
            await awaitMaybeWithResponse(request);
          if (response && response.status !== 200) {
            throw new Error(`Expected status 200, got ${response.status}`);
          }
          const streamOnly =
            typeof request?.withResponse === "function"
              ? await request
              : chatStream;
          if (streamOnly !== chatStream) {
            throw new Error(
              "Expected direct await to return cached withResponse stream",
            );
          }
          await collectAsync(streamOnly);
        },
      );

      await runOperation(
        "openai-stream-tool-operation",
        "stream-tool",
        async () => {
          const chatStream = await client.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
              {
                role: "user",
                content:
                  "Use the get_weather tool for Paris, France. Do not answer from memory.",
              },
            ],
            stream: true,
            max_tokens: 64,
            temperature: 0,
            stream_options: {
              include_usage: true,
            },
            tool_choice: {
              type: "function",
              function: { name: "get_weather" },
            },
            tools: CHAT_TOOLS,
          });
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

      await runOperation(
        "openai-stream-multiple-choices-operation",
        "stream-multiple-choices",
        async () => {
          const chatStream =
            await multipleChoicesStreamFixtureClient.chat.completions.create({
              model: OPENAI_MODEL,
              messages: [
                {
                  role: "user",
                  content:
                    "Return two streamed choices with two weather tool calls each.",
                },
              ],
              stream: true,
              n: 2,
              parallel_tool_calls: true,
              max_tokens: 12,
              temperature: 0,
              tools: CHAT_TOOLS,
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

      await runOpenAIMediaOperations(client, openAIMajorVersion);

      await runOperation("openai-batch-operation", "batch", async () => {
        const batchItems = [
          {
            customId: "batch_chat_alpha",
            prompt: "Reply with exactly ALPHA.",
            response: "ALPHA",
          },
          {
            customId: "batch_chat_bravo",
            prompt: "Reply with exactly BRAVO.",
            response: "BRAVO",
          },
          {
            customId: "batch_chat_charlie",
            prompt: "Reply with exactly CHARLIE.",
            response: "CHARLIE",
          },
        ];
        const input = batchItems
          .map((item) =>
            JSON.stringify({
              custom_id: item.customId,
              method: "POST",
              url: "/v1/chat/completions",
              body: {
                model: OPENAI_MODEL,
                messages: [{ role: "user", content: item.prompt }],
              },
            }),
          )
          .join("\n");
        const inputFile = await openaiFilesCreateTraced(
          batchFixtureClient.files,
        )({
          file: new File([input], "batch.jsonl"),
          purpose: "batch",
        });
        const created = await batchFixtureClient.batches.create({
          input_file_id: inputFile.id,
          completion_window: "24h",
          endpoint: "/v1/chat/completions",
        });
        const completed = await openaiBatchesRetrieveTraced(
          batchFixtureClient.batches,
        )(created.id);
        // Start both content requests before awaiting either one. These promises
        // model the APIPromise<Response> values returned by files.content().
        const outputFile = Promise.resolve(
          new Response(
            [batchItems[1], batchItems[0]]
              .map((item, index) =>
                JSON.stringify({
                  custom_id: item.customId,
                  response: {
                    status_code: 200,
                    body: {
                      choices: [
                        {
                          index: 0,
                          finish_reason: "stop",
                          message: {
                            role: "assistant",
                            content: item.response,
                          },
                        },
                      ],
                      usage: {
                        prompt_tokens: 8 + index,
                        completion_tokens: 1,
                        total_tokens: 9 + index,
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
              custom_id: batchItems[2].customId,
              error: {
                code: "fixture_error",
                message: "Batch fixture request failed",
              },
            }),
          ),
        );
        await completeOpenAIBatchTrace({
          inputFileId: completed.input_file_id,
          inputFileContent: input,
          // Batch results are not guaranteed to preserve input order.
          outputFileContent: outputFile,
          errorFileContent: errorFile,
        });
        if (!(await outputFile).bodyUsed || !(await errorFile).bodyUsed) {
          throw new Error("Expected batch result responses to be consumed");
        }
      });
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
