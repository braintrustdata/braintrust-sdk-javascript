import { initLogger } from "braintrust";
import { BraintrustTelemetryIntegration } from "braintrust";
import {
  Experimental_Agent,
  generateText,
  streamText,
  tool,
  registerTelemetryIntegration,
  stepCountIs,
} from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";

export const ROOT_NAME = "ai-sdk-telemetry-integration-root";
export const SCENARIO_NAME = "ai-sdk-telemetry-integration";

function getTestRunId(): string {
  return process.env.BRAINTRUST_E2E_RUN_ID!;
}

function scopedName(base: string): string {
  if (process.env.BRAINTRUST_E2E_PROJECT_NAME) {
    return process.env.BRAINTRUST_E2E_PROJECT_NAME;
  }
  const suffix = getTestRunId()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  return `${base}-${suffix}`;
}

/**
 * Creates a mock model that returns a simple text response.
 */
function createTextModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-provider",
    modelId: "mock-model",
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
      request: { body: "{}" },
      response: {
        id: "response-1",
        modelId: "mock-model",
        timestamp: new Date(0),
        headers: {},
        body: undefined,
      },
      rawResponse: undefined,
      warnings: [],
      providerMetadata: undefined,
    },
  });
}

/**
 * Creates a mock model that streams text word-by-word.
 * Uses the LanguageModelV4StreamPart format (text-start, text-delta with delta, text-end).
 */
function createStreamModel(text: string): MockLanguageModelV4 {
  const words = text.split(" ");
  const textId = "text-block-1";
  return new MockLanguageModelV4({
    provider: "mock-provider",
    modelId: "mock-model",
    doStream: {
      stream: convertArrayToReadableStream([
        { type: "text-start" as const, id: textId },
        ...words.map((word, i) => ({
          type: "text-delta" as const,
          id: textId,
          delta: i === 0 ? word : ` ${word}`,
        })),
        { type: "text-end" as const, id: textId },
        {
          type: "finish" as const,
          finishReason: "stop" as const,
          usage: { inputTokens: 10, outputTokens: words.length },
        },
      ]),
      request: { body: "{}" },
      response: {
        id: "response-1",
        modelId: "mock-model",
        timestamp: new Date(0),
        headers: {},
        body: undefined,
      },
      rawResponse: undefined,
      warnings: [],
    },
  });
}

/**
 * Creates a mock model that generates a tool call, then responds with text.
 */
function createToolCallModel(): MockLanguageModelV4 {
  let callCount = 0;
  return new MockLanguageModelV4({
    provider: "mock-provider",
    modelId: "mock-model",
    doGenerate: async () => {
      callCount++;
      if (callCount === 1) {
        // First call: return a tool call (V4 format uses `input` not `args`)
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tool-call-1",
              toolName: "get_weather",
              input: JSON.stringify({ location: "Paris, France" }),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 15, outputTokens: 20 },
          request: { body: "{}" },
          response: {
            id: "response-1",
            modelId: "mock-model",
            timestamp: new Date(0),
            headers: {},
            body: undefined,
          },
          rawResponse: undefined,
          warnings: [],
          providerMetadata: undefined,
        };
      }
      // Second call: return text after tool result
      return {
        content: [
          {
            type: "text" as const,
            text: "The weather in Paris is sunny, 22°C.",
          },
        ],
        finishReason: "stop" as const,
        usage: { inputTokens: 25, outputTokens: 15 },
        request: { body: "{}" },
        response: {
          id: "response-2",
          modelId: "mock-model",
          timestamp: new Date(0),
          headers: {},
          body: undefined,
        },
        rawResponse: undefined,
        warnings: [],
        providerMetadata: undefined,
      };
    },
  });
}

/**
 * Creates a mock model that makes two tool calls, allowing us to verify
 * nested sub-agent traces are parented under each tool span.
 */
function createNestedToolCallModel(): MockLanguageModelV4 {
  let callCount = 0;
  return new MockLanguageModelV4({
    provider: "mock-provider",
    modelId: "mock-model",
    doGenerate: async () => {
      callCount++;
      if (callCount <= 2) {
        const city = callCount === 1 ? "Paris" : "Tokyo";
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `research-city-${callCount}`,
              toolName: "researchCity",
              input: JSON.stringify({ city }),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 15, outputTokens: 20 },
          request: { body: "{}" },
          response: {
            id: `nested-response-${callCount}`,
            modelId: "mock-model",
            timestamp: new Date(0),
            headers: {},
            body: undefined,
          },
          rawResponse: undefined,
          warnings: [],
          providerMetadata: undefined,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Finished researching cities.",
          },
        ],
        finishReason: "stop" as const,
        usage: { inputTokens: 25, outputTokens: 15 },
        request: { body: "{}" },
        response: {
          id: "nested-response-final",
          modelId: "mock-model",
          timestamp: new Date(0),
          headers: {},
          body: undefined,
        },
        rawResponse: undefined,
        warnings: [],
        providerMetadata: undefined,
      };
    },
  });
}

/**
 * Creates a mock model that throws an error during generation.
 */
function createErrorModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-provider",
    modelId: "mock-model",
    doGenerate: async () => {
      throw new Error("Mock generation error");
    },
  });
}

export async function runTelemetryIntegrationScenario(): Promise<void> {
  const testRunId = getTestRunId();
  const integration = new BraintrustTelemetryIntegration();

  // Register globally
  registerTelemetryIntegration(integration);

  const logger = initLogger({
    projectName: scopedName("e2e-ai-sdk-telemetry-integration"),
  });

  await logger.traced(
    async () => {
      // 1. generateText — basic
      await generateText({
        model: createTextModel("PARIS"),
        prompt: "Reply with the single token PARIS.",
        experimental_telemetry: {
          metadata: {
            braintrust: {
              name: "custom-generate-name",
              metadata: { user: "test-user" },
              spanAttributes: { type: "llm" },
            },
          },
        },
      });

      // 2. streamText — basic
      const streamResult = streamText({
        model: createStreamModel("one two three"),
        prompt: "Count from 1 to 3.",
        experimental_telemetry: {
          metadata: {
            braintrust: {
              name: "custom-stream-name",
            },
          },
        },
      });
      // Consume the stream
      for await (const _chunk of streamResult.textStream) {
        // consume
      }

      // 3. generateText with tool calls
      await generateText({
        model: createToolCallModel(),
        prompt: "What is the weather in Paris?",
        tools: {
          get_weather: tool({
            description: "Get the weather for a location",
            parameters: z.object({
              location: z.string().describe("The city and country"),
            }),
            execute: async (args) =>
              JSON.stringify({
                condition: "sunny",
                location: args.location,
                temperatureC: 22,
              }),
          }),
        },
        stopWhen: stepCountIs(4),
        experimental_telemetry: {
          metadata: {
            braintrust: {
              name: "tool-call-generate",
            },
          },
        },
      });

      // 4. generateText with nested sub-agent tool calls
      const researchAgent = new Experimental_Agent({
        model: createTextModel("Nested research complete."),
        instructions: "You are a city researcher.",
      });

      await generateText({
        model: createNestedToolCallModel(),
        prompt: "Research Paris and Tokyo.",
        tools: {
          researchCity: tool({
            description: "Research a city",
            parameters: z.object({
              city: z.string().describe("The city to research"),
            }),
            execute: async ({ city }) => {
              const result = await researchAgent.generate({
                prompt: `Research ${city}`,
              });
              return JSON.stringify({ city, summary: result.text });
            },
          }),
        },
        stopWhen: stepCountIs(5),
        experimental_telemetry: {
          metadata: {
            braintrust: {
              name: "nested-tool-call-generate",
            },
          },
        },
      });

      // 5. generateText with error
      try {
        await generateText({
          model: createErrorModel(),
          prompt: "This will fail.",
          experimental_telemetry: {
            metadata: {
              braintrust: {
                name: "error-generate",
              },
            },
          },
        });
      } catch {
        // Expected error - we want to verify error is captured on the span
      }
    },
    {
      name: ROOT_NAME,
      event: {
        metadata: {
          scenario: SCENARIO_NAME,
          testRunId,
        },
      },
    },
  );

  await logger.flush();
}
