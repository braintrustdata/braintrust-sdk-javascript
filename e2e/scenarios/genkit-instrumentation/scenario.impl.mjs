import { wrapGenkit } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import { ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

export const GENKIT_SCENARIO_TIMEOUT_MS = 90_000;

const GOOGLE_MODEL_NAME = "gemini-2.5-flash-lite";
const GOOGLE_EMBEDDING_MODEL_NAME = "gemini-embedding-001";
const GOOGLE_GENAI_RETRY_OPTIONS = {
  attempts: 4,
  delayMs: 1_000,
  maxDelayMs: 8_000,
  shouldRetry: isRetriableGoogleGenAIError,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getRetryStatus(error) {
  if (!isObject(error)) {
    return undefined;
  }

  const directStatus = error.status;
  if (typeof directStatus === "number") {
    return directStatus;
  }

  const nestedError = error.error;
  if (
    isObject(nestedError) &&
    typeof nestedError.code === "number" &&
    Number.isFinite(nestedError.code)
  ) {
    return nestedError.code;
  }

  return undefined;
}

function isRetriableGoogleGenAIError(error) {
  const status = getRetryStatus(error);
  if (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("request timed out") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("unavailable") ||
    normalizedMessage.includes("high demand")
  );
}

async function withRetry(
  callback,
  {
    attempts = 3,
    delayMs = 1_000,
    maxDelayMs = Number.POSITIVE_INFINITY,
    shouldRetry = () => true,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) {
        throw error;
      }
      const retryDelayMs = Math.min(delayMs * attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw lastError;
}

async function buildAI(options = {}) {
  const { genkit, z } = await import("genkit");
  const { googleAI } = await import("@genkit-ai/google-genai");
  const baseAI = genkit({
    plugins: [googleAI()],
    model: googleAI.model(GOOGLE_MODEL_NAME),
    promptDir: null,
  });
  const ai = options.wrap ? wrapGenkit(baseAI) : baseAI;

  return {
    ai,
    embedder: googleAI.embedder(GOOGLE_EMBEDDING_MODEL_NAME),
    model: googleAI.model(GOOGLE_MODEL_NAME),
    z,
  };
}

export async function runGenkitInstrumentationScenario(options = {}) {
  const { ai, embedder, model, z } = await buildAI(options);

  const summarizeTool = ai.defineTool(
    {
      name: "summarizeCity",
      description: "Summarizes a city.",
      inputSchema: z.object({
        city: z.string(),
      }),
      outputSchema: z.object({
        summary: z.string(),
      }),
    },
    async ({ city }) => ({
      summary: `${city} has precise instrumentation weather.`,
    }),
  );

  const recipeFlow = ai.defineFlow(
    {
      name: "recipeFlow",
      inputSchema: z.string(),
      outputSchema: z.object({
        recipe: z.string(),
      }),
    },
    async (topic) => {
      const normalized = await ai.run("normalize-topic", topic, async (input) =>
        String(input).trim().toLowerCase(),
      );
      const response = await withRetry(
        () =>
          ai.generate({
            model,
            prompt: `Write a recipe about ${normalized}.`,
            config: {
              temperature: 0,
              maxOutputTokens: 32,
            },
          }),
        GOOGLE_GENAI_RETRY_OPTIONS,
      );
      return {
        recipe: response.text,
      };
    },
  );

  await runTracedScenario({
    callback: async () => {
      await runOperation("genkit-generate-operation", "generate", async () => {
        await withRetry(
          () =>
            ai.generate({
              model,
              prompt: "Reply with exactly OK.",
              config: {
                temperature: 0,
                maxOutputTokens: 24,
              },
            }),
          GOOGLE_GENAI_RETRY_OPTIONS,
        );
      });

      await runOperation("genkit-stream-operation", "stream", async () => {
        await withRetry(async () => {
          const { response, stream } = ai.generateStream({
            model,
            prompt: "Stream a short phrase.",
            config: {
              temperature: 0,
              maxOutputTokens: 32,
            },
          });
          await collectAsync(stream);
          await response;
        }, GOOGLE_GENAI_RETRY_OPTIONS);
      });

      await runOperation("genkit-embed-operation", "embed", async () => {
        await withRetry(
          () =>
            ai.embed({
              embedder,
              content: "embed this",
            }),
          GOOGLE_GENAI_RETRY_OPTIONS,
        );
      });

      await runOperation("genkit-tool-operation", "tool", async () => {
        await summarizeTool.run({
          city: "Vienna",
        });
      });

      await runOperation("genkit-flow-operation", "flow", async () => {
        await recipeFlow("Cake");
      });
    },
    flushCount: 2,
    flushDelayMs: 20,
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-genkit-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedGenkitInstrumentation() {
  await runGenkitInstrumentationScenario({ wrap: true });
}

export async function runAutoGenkitInstrumentation() {
  await runGenkitInstrumentationScenario();
}
