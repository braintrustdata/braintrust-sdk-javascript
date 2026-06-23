import { wrapBedrockRuntime } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  CACHE_PROMPT_MARKER,
  MODEL,
  REGION,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

export const BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS = 180_000;

const CACHEABLE_CONTEXT = `${CACHE_PROMPT_MARKER}
${Array.from({ length: 1_600 }, (_, index) => `stable-cache-token-${index}`).join(" ")}
Use this stable cache context only to exercise Bedrock prompt caching in this e2e scenario.`;

function cachedConverseMessageContent(text) {
  return [
    {
      text: CACHEABLE_CONTEXT,
    },
    {
      cachePoint: {
        type: "default",
      },
    },
    {
      text,
    },
  ];
}

function cachedNovaMessageContent(text) {
  return [
    {
      text: CACHEABLE_CONTEXT,
      cachePoint: {
        type: "default",
      },
    },
    {
      text,
    },
  ];
}

function novaMessageBody(text) {
  return {
    schemaVersion: "messages-v1",
    messages: [
      {
        role: "user",
        content: cachedNovaMessageContent(text),
      },
    ],
    inferenceConfig: {
      maxTokens: 16,
      temperature: 0,
      topP: 0.9,
    },
  };
}

function bedrockClientConfig(NodeHttpHandler) {
  const endpoint =
    process.env.AWS_BEDROCK_RUNTIME_BASE_URL ??
    process.env.BEDROCK_RUNTIME_BASE_URL;
  return {
    region: REGION,
    requestHandler: new NodeHttpHandler({
      requestTimeout: BEDROCK_RUNTIME_SCENARIO_TIMEOUT_MS,
    }),
    ...(endpoint ? { endpoint } : {}),
  };
}

function assertBedrockAuthEnv() {
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    throw new Error("Expected AWS_BEARER_TOKEN_BEDROCK to be set for e2e");
  }
}

export async function runBedrockRuntimeInstrumentationScenario(options) {
  assertBedrockAuthEnv();

  const baseClient = new options.BedrockRuntimeClient(
    bedrockClientConfig(options.NodeHttpHandler),
  );
  const client = options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;

  await runTracedScenario({
    callback: async () => {
      await runOperation("bedrock-converse-operation", "converse", async () => {
        await client.send(
          new options.ConverseCommand({
            inferenceConfig: {
              maxTokens: 16,
              temperature: 0,
              topP: 0.9,
            },
            messages: [
              {
                role: "user",
                content: cachedConverseMessageContent("Reply with exactly OK."),
              },
            ],
            modelId: MODEL,
          }),
        );
      });

      await runOperation(
        "bedrock-converse-stream-operation",
        "converse-stream",
        async () => {
          const response = await client.send(
            new options.ConverseStreamCommand({
              inferenceConfig: {
                maxTokens: 16,
                temperature: 0,
                topP: 0.9,
              },
              messages: [
                {
                  role: "user",
                  content: cachedConverseMessageContent(
                    "Reply with exactly STREAM.",
                  ),
                },
              ],
              modelId: MODEL,
            }),
          );
          await collectAsync(response.stream ?? []);
        },
      );

      await runOperation(
        "bedrock-invoke-model-operation",
        "invoke-model",
        async () => {
          await client.send(
            new options.InvokeModelCommand({
              accept: "application/json",
              body: JSON.stringify(novaMessageBody("Reply with exactly RAW.")),
              contentType: "application/json",
              modelId: MODEL,
            }),
          );
        },
      );

      await runOperation(
        "bedrock-invoke-model-stream-operation",
        "invoke-model-stream",
        async () => {
          const response = await client.send(
            new options.InvokeModelWithResponseStreamCommand({
              accept: "application/json",
              body: JSON.stringify(
                novaMessageBody("Reply with exactly RAWSTREAM."),
              ),
              contentType: "application/json",
              modelId: MODEL,
            }),
          );
          await collectAsync(response.body ?? []);
        },
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-bedrock-runtime-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedBedrockRuntimeInstrumentation(options) {
  await runBedrockRuntimeInstrumentationScenario({
    decorateClient: wrapBedrockRuntime,
    ...options,
  });
}

export async function runAutoBedrockRuntimeInstrumentation(options) {
  await runBedrockRuntimeInstrumentationScenario(options);
}
