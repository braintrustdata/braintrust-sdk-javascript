import { wrapOllama } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  EMBEDDING_MODEL,
  GENERATION_MODEL,
  LEGACY_EMBEDDING_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

export const OLLAMA_SCENARIO_TIMEOUT_MS = 240_000;

function requireOllamaConfig() {
  const apiKey = process.env.OLLAMA_API_KEY;
  const host = process.env.OLLAMA_HOST;
  if (!apiKey) {
    throw new Error("Expected OLLAMA_API_KEY to be set for e2e");
  }
  if (!host) {
    throw new Error("Expected OLLAMA_HOST to be set for e2e");
  }
  return { apiKey, host };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function syntheticFetch(input, init) {
  const url = String(input);
  const body =
    typeof init?.body === "string" && init.body.length > 0
      ? JSON.parse(init.body)
      : {};

  if (url.endsWith("/api/embed")) {
    return jsonResponse({
      model: body.model,
      embeddings: [
        [0.1, 0.2, 0.3, 0.4],
        [0.5, 0.6, 0.7, 0.8],
      ],
      prompt_eval_count: 4,
      total_duration: 100,
      load_duration: 10,
    });
  }

  if (url.endsWith("/api/embeddings")) {
    return jsonResponse({ embedding: [0.1, 0.2, 0.3] });
  }

  if (url.endsWith("/api/chat") && Array.isArray(body.tools)) {
    return jsonResponse({
      model: body.model,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "get_temperature",
              arguments: { city: "Paris" },
            },
          },
        ],
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 12,
      eval_count: 5,
    });
  }

  return jsonResponse({ error: "synthetic Ollama failure" }, 500);
}

function generationOptions() {
  return {
    temperature: 0,
    num_predict: 128,
  };
}

async function runOllamaInstrumentationScenario(
  Ollama,
  { decorateClient } = {},
) {
  const { apiKey, host } = requireOllamaConfig();
  const headers = { Authorization: `Bearer ${apiKey}` };
  const liveBaseClient = new Ollama({ host, headers });
  const syntheticBaseClient = new Ollama({
    host: "http://synthetic.ollama.test",
    headers,
    fetch: syntheticFetch,
  });
  const liveClient = decorateClient
    ? decorateClient(liveBaseClient)
    : liveBaseClient;
  const syntheticClient = decorateClient
    ? decorateClient(syntheticBaseClient)
    : syntheticBaseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("ollama-chat-operation", "chat", async () => {
        const response = await liveClient.chat({
          model: GENERATION_MODEL,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          options: generationOptions(),
          think: false,
        });
        if (!response?.message?.content) {
          throw new Error("Expected Ollama chat response content");
        }
      });

      await runOperation(
        "ollama-chat-stream-operation",
        "chat-stream",
        async () => {
          const stream = await liveClient.chat({
            model: GENERATION_MODEL,
            messages: [{ role: "user", content: "Reply with exactly STREAM." }],
            options: generationOptions(),
            stream: true,
            think: false,
          });
          const chunks = await collectAsync(stream);
          if (chunks.length === 0) {
            throw new Error("Expected Ollama chat stream chunks");
          }
        },
      );

      await runOperation("ollama-generate-operation", "generate", async () => {
        const response = await liveClient.generate({
          model: GENERATION_MODEL,
          prompt: "Reply with exactly OK.",
          options: generationOptions(),
          think: false,
        });
        if (!response?.response) {
          throw new Error("Expected Ollama generate response content");
        }
      });

      await runOperation(
        "ollama-generate-stream-operation",
        "generate-stream",
        async () => {
          const stream = await liveClient.generate({
            model: GENERATION_MODEL,
            prompt: "Reply with exactly STREAM.",
            options: generationOptions(),
            stream: true,
            think: false,
          });
          const chunks = await collectAsync(stream);
          if (chunks.length === 0) {
            throw new Error("Expected Ollama generate stream chunks");
          }
        },
      );

      await runOperation(
        "ollama-tool-call-operation",
        "tool-call",
        async () => {
          await syntheticClient.chat({
            model: GENERATION_MODEL,
            messages: [
              {
                role: "user",
                content: "Use get_temperature for Paris.",
              },
            ],
            tools: [
              {
                type: "function",
                function: {
                  name: "get_temperature",
                  description: "Get the temperature for a city",
                  parameters: {
                    type: "object",
                    properties: {
                      city: { type: "string" },
                    },
                    required: ["city"],
                  },
                },
              },
            ],
          });
        },
      );

      await runOperation("ollama-embed-operation", "embed", async () => {
        await syntheticClient.embed({
          model: EMBEDDING_MODEL,
          input: ["braintrust tracing", "ollama instrumentation"],
        });
      });

      await runOperation(
        "ollama-embeddings-operation",
        "embeddings",
        async () => {
          await syntheticClient.embeddings({
            model: LEGACY_EMBEDDING_MODEL,
            prompt: "braintrust tracing",
          });
        },
      );

      await runOperation("ollama-error-operation", "error", async () => {
        try {
          await syntheticClient.chat({
            model: GENERATION_MODEL,
            messages: [{ role: "user", content: "Trigger an error." }],
          });
          throw new Error("Expected synthetic Ollama request to fail");
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "Expected synthetic Ollama request to fail"
          ) {
            throw error;
          }
        }
      });
    },
    metadata: { scenario: SCENARIO_NAME },
    projectNameBase: "e2e-ollama-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedOllamaInstrumentation(Ollama) {
  await runOllamaInstrumentationScenario(Ollama, {
    decorateClient: wrapOllama,
  });
}

export async function runAutoOllamaInstrumentation(Ollama) {
  await runOllamaInstrumentationScenario(Ollama);
}
