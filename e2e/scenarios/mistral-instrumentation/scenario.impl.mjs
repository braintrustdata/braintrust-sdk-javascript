import { wrapMistral } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  AGENT_MODEL,
  CHAT_MODEL,
  EMBEDDING_MODEL,
  FIM_MODEL,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

export const MISTRAL_SCENARIO_TIMEOUT_MS = 240_000;
const TEST_TOOL_DELAY_MS = 50;
const MISTRAL_REQUEST_RETRY_OPTIONS = {
  attempts: 5,
  delayMs: 2_000,
  maxDelayMs: 10_000,
};
export const MISTRAL_SCENARIO_SPECS = [
  {
    autoEntry: "scenario.mistral-v1-3-4.mjs",
    dependencyName: "mistral-sdk-v1-3-4",
    snapshotName: "mistral-v1-3-4",
    supportsAutoHook: false,
    wrapperEntry: "scenario.mistral-v1-3-4.ts",
  },
  {
    autoEntry: "scenario.mistral-v1-10-0.mjs",
    dependencyName: "mistral-sdk-v1-10-0",
    snapshotName: "mistral-v1-10-0",
    supportsAutoHook: false,
    wrapperEntry: "scenario.mistral-v1-10-0.ts",
  },
  {
    autoEntry: "scenario.mistral-v1-14-1.mjs",
    dependencyName: "mistral-sdk-v1-14-1",
    snapshotName: "mistral-v1-14-1",
    supportsAutoHook: false,
    wrapperEntry: "scenario.mistral-v1-14-1.ts",
  },
  {
    autoEntry: "scenario.mistral-v1-15-1.mjs",
    dependencyName: "mistral-sdk-v1-15-1",
    snapshotName: "mistral-v1-15-1",
    supportsAutoHook: false,
    wrapperEntry: "scenario.mistral-v1-15-1.ts",
  },
  {
    autoEntry: "scenario.mistral-v1.mjs",
    dependencyName: "mistral-sdk-v1",
    snapshotName: "mistral-v1",
    supportsAutoHook: false,
    wrapperEntry: "scenario.mistral-v1.ts",
  },
  {
    autoEntry: "scenario.mjs",
    dependencyName: "mistral-sdk-v2",
    snapshotName: "mistral-v2",
    supportsAutoHook: true,
    wrapperEntry: "scenario.ts",
  },
];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isMistralInputValidationError(error) {
  return (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.includes("Input validation failed")
  );
}

function getWeatherToolDefinition({ legacy = false } = {}) {
  return {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city.",
      parameters: legacy
        ? {}
        : {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "City name, e.g. Vienna.",
              },
            },
            required: ["location"],
          },
    },
  };
}

function getExchangeRateToolDefinition({ legacy = false } = {}) {
  return {
    type: "function",
    function: {
      name: "get_exchange_rate",
      description: "Get currency exchange rate.",
      parameters: legacy
        ? {}
        : {
            type: "object",
            properties: {
              from_currency: {
                type: "string",
                description: "Base currency code, e.g. USD.",
              },
              to_currency: {
                type: "string",
                description: "Target currency code, e.g. EUR.",
              },
            },
            required: ["from_currency", "to_currency"],
          },
    },
  };
}

function getAgentTimeToolDefinition({ legacy = false } = {}) {
  return {
    type: "function",
    function: {
      name: "get_time_in_city",
      description: "Get the local time in a city.",
      parameters: legacy
        ? {}
        : {
            type: "object",
            properties: {
              city: {
                type: "string",
                description: "City name, e.g. Vienna.",
              },
            },
            required: ["city"],
          },
    },
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function getAgentId(agent) {
  if (!isRecord(agent)) {
    return null;
  }

  if (nonEmptyString(agent.id)) {
    return agent.id.trim();
  }

  if (nonEmptyString(agent.agentId)) {
    return agent.agentId.trim();
  }

  if (nonEmptyString(agent.agent_id)) {
    return agent.agent_id.trim();
  }

  return null;
}

function getMistralApiBaseUrl(client) {
  const envBaseUrl =
    nonEmptyString(process.env.MISTRAL_API_URL) ||
    nonEmptyString(process.env.MISTRAL_BASE_URL);
  if (envBaseUrl) {
    return envBaseUrl.replace(/\/+$/g, "");
  }

  const options =
    isRecord(client) && isRecord(client._options) ? client._options : undefined;
  const optionBaseUrl =
    (isRecord(options) && nonEmptyString(options.serverURL)) ||
    (isRecord(options) && nonEmptyString(options.serverUrl)) ||
    (isRecord(options) && nonEmptyString(options.baseURL)) ||
    (isRecord(options) && nonEmptyString(options.baseUrl));

  return (optionBaseUrl || "https://api.mistral.ai").replace(/\/+$/g, "");
}

function getAgentCreatePayload() {
  return {
    model: AGENT_MODEL,
    name: `braintrust-e2e-${Date.now().toString(36)}`,
    instructions: "You are concise. Keep responses under five words.",
  };
}

async function withRetry(
  callback,
  { attempts = 3, delayMs = 1_000, maxDelayMs = Number.POSITIVE_INFINITY } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw error;
      }
      const retryDelayMs = Math.min(delayMs * attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw lastError;
}

async function simulateToolExecutionDelay() {
  await new Promise((resolve) => setTimeout(resolve, TEST_TOOL_DELAY_MS));
}

async function createAgentViaHttp(client, apiKey) {
  const baseUrl = getMistralApiBaseUrl(client);
  const response = await withRetry(
    async () =>
      fetch(`${baseUrl}/v1/agents`, {
        body: JSON.stringify(getAgentCreatePayload()),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    MISTRAL_REQUEST_RETRY_OPTIONS,
  );
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Failed to create temporary Mistral agent (${response.status}): ${responseBody}`,
    );
  }

  const parsed = JSON.parse(responseBody);
  const createdAgentId = getAgentId(parsed);
  if (!createdAgentId) {
    throw new Error("Mistral agent creation response did not include an id.");
  }

  return {
    agentId: createdAgentId,
    cleanup: async () => {
      try {
        await fetch(`${baseUrl}/v1/agents/${createdAgentId}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          method: "DELETE",
        });
      } catch {
        // Ignore cleanup failures for temporary e2e agents.
      }
    },
  };
}

async function createAgentViaSdk(client, apiKey) {
  const beta = isRecord(client) && isRecord(client.beta) ? client.beta : null;
  const agentManager = beta && isRecord(beta.agents) ? beta.agents : null;
  const createAgent = agentManager?.create;
  if (typeof createAgent !== "function") {
    return null;
  }

  const created = await withRetry(
    async () => createAgent.call(agentManager, getAgentCreatePayload()),
    MISTRAL_REQUEST_RETRY_OPTIONS,
  );
  const createdAgentId = getAgentId(created);
  if (!createdAgentId) {
    throw new Error("beta.agents.create() did not return an agent id.");
  }

  const deleteAgent = agentManager?.delete;
  if (typeof deleteAgent === "function") {
    return {
      agentId: createdAgentId,
      cleanup: async () => {
        try {
          await deleteAgent.call(agentManager, { agentId: createdAgentId });
        } catch {
          // Ignore cleanup failures for temporary e2e agents.
        }
      },
    };
  }

  const baseUrl = getMistralApiBaseUrl(client);
  return {
    agentId: createdAgentId,
    cleanup: async () => {
      try {
        await fetch(`${baseUrl}/v1/agents/${createdAgentId}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          method: "DELETE",
        });
      } catch {
        // Ignore cleanup failures for temporary e2e agents.
      }
    },
  };
}

async function resolveAgentRuntime(client) {
  const configuredAgentId = nonEmptyString(process.env.MISTRAL_AGENT_ID);
  if (configuredAgentId) {
    return {
      agentId: configuredAgentId,
      cleanup: async () => {},
    };
  }

  const apiKey = nonEmptyString(process.env.MISTRAL_API_KEY);
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is required for Mistral e2e scenarios.");
  }

  try {
    const sdkRuntime = await createAgentViaSdk(client, apiKey);
    if (sdkRuntime) {
      return sdkRuntime;
    }
  } catch {
    // Fall back to direct API provisioning when SDK beta management is unavailable.
  }

  return await createAgentViaHttp(client, apiKey);
}

async function runMistralInstrumentationScenario(
  Mistral,
  { decorateClient } = {},
) {
  const baseClient = new Mistral({
    apiKey: process.env.MISTRAL_API_KEY,
  });
  const client = decorateClient ? decorateClient(baseClient) : baseClient;
  const { agentId, cleanup } = await resolveAgentRuntime(baseClient);

  try {
    await runTracedScenario({
      callback: async () => {
        await runOperation(
          "mistral-chat-complete-operation",
          "chat-complete",
          async () => {
            await withRetry(
              async () =>
                client.chat.complete({
                  model: CHAT_MODEL,
                  messages: [
                    {
                      role: "system",
                      content:
                        "You are concise. Keep responses under five words.",
                    },
                    {
                      role: "user",
                      content: "Reply with exactly: observability",
                    },
                  ],
                  maxTokens: 16,
                  temperature: 0,
                }),
              MISTRAL_REQUEST_RETRY_OPTIONS,
            );
          },
        );

        await runOperation(
          "mistral-chat-stream-operation",
          "chat-stream",
          async () => {
            await withRetry(async () => {
              const stream = await client.chat.stream({
                model: CHAT_MODEL,
                messages: [
                  {
                    role: "user",
                    content: "Reply with exactly: streamed output",
                  },
                ],
                maxTokens: 24,
                stream: true,
                temperature: 0,
              });
              await collectAsync(stream);
            }, MISTRAL_REQUEST_RETRY_OPTIONS);
          },
        );

        await runOperation(
          "mistral-chat-tool-call-operation",
          "chat-tool-call",
          async () => {
            await withRetry(async () => {
              const request = {
                model: CHAT_MODEL,
                messages: [
                  {
                    role: "user",
                    content:
                      "Call the get_weather tool for Vienna. Do not answer with plain text.",
                  },
                ],
                toolChoice: "required",
                maxTokens: 48,
                temperature: 0,
              };

              try {
                return await client.chat.complete({
                  ...request,
                  tools: [getWeatherToolDefinition()],
                });
              } catch (error) {
                if (!isMistralInputValidationError(error)) {
                  throw error;
                }

                return await client.chat.complete({
                  ...request,
                  tools: [getWeatherToolDefinition({ legacy: true })],
                });
              }
            }, MISTRAL_REQUEST_RETRY_OPTIONS);
            await simulateToolExecutionDelay();

            await withRetry(async () => {
              const request = {
                model: CHAT_MODEL,
                messages: [
                  {
                    role: "user",
                    content:
                      "Call the get_exchange_rate tool for USD to EUR. Do not answer with plain text.",
                  },
                ],
                toolChoice: "required",
                maxTokens: 48,
                temperature: 0,
              };

              try {
                return await client.chat.complete({
                  ...request,
                  tools: [getExchangeRateToolDefinition()],
                });
              } catch (error) {
                if (!isMistralInputValidationError(error)) {
                  throw error;
                }

                return await client.chat.complete({
                  ...request,
                  tools: [getExchangeRateToolDefinition({ legacy: true })],
                });
              }
            }, MISTRAL_REQUEST_RETRY_OPTIONS);
            await simulateToolExecutionDelay();

            await withRetry(async () => {
              const request = {
                model: CHAT_MODEL,
                messages: [
                  {
                    role: "system",
                    content:
                      "You must return only tool calls and no plain text.",
                  },
                  {
                    role: "user",
                    content:
                      "In a single assistant response, call exactly two tools: get_weather with location Vienna and get_exchange_rate with from_currency USD and to_currency EUR.",
                  },
                ],
                toolChoice: "required",
                maxTokens: 96,
                temperature: 0,
              };

              try {
                return await client.chat.complete({
                  ...request,
                  tools: [
                    getWeatherToolDefinition(),
                    getExchangeRateToolDefinition(),
                  ],
                });
              } catch (error) {
                if (!isMistralInputValidationError(error)) {
                  throw error;
                }

                return await client.chat.complete({
                  ...request,
                  tools: [
                    getWeatherToolDefinition({ legacy: true }),
                    getExchangeRateToolDefinition({ legacy: true }),
                  ],
                });
              }
            }, MISTRAL_REQUEST_RETRY_OPTIONS);
            await simulateToolExecutionDelay();
          },
        );

        await runOperation(
          "mistral-fim-complete-operation",
          "fim-complete",
          async () => {
            await withRetry(
              async () =>
                client.fim.complete({
                  model: FIM_MODEL,
                  prompt: "function add(a, b) {",
                  suffix: "}",
                  maxTokens: 24,
                  temperature: 0,
                }),
              MISTRAL_REQUEST_RETRY_OPTIONS,
            );
          },
        );

        await runOperation(
          "mistral-fim-stream-operation",
          "fim-stream",
          async () => {
            await withRetry(async () => {
              const stream = await client.fim.stream({
                model: FIM_MODEL,
                prompt: "const project = ",
                suffix: ";",
                maxTokens: 16,
                stream: true,
                temperature: 0,
              });
              await collectAsync(stream);
            }, MISTRAL_REQUEST_RETRY_OPTIONS);
          },
        );

        await runOperation(
          "mistral-agents-complete-operation",
          "agents-complete",
          async () => {
            await withRetry(
              async () =>
                client.agents.complete({
                  agentId,
                  messages: [
                    {
                      role: "user",
                      content: "Reply with exactly: agent complete",
                    },
                  ],
                  responseFormat: {
                    type: "text",
                  },
                  maxTokens: 12,
                  temperature: 0,
                }),
              MISTRAL_REQUEST_RETRY_OPTIONS,
            );
          },
        );

        await runOperation(
          "mistral-agents-tool-call-operation",
          "agents-tool-call",
          async () => {
            await withRetry(async () => {
              const request = {
                agentId,
                messages: [
                  {
                    role: "user",
                    content:
                      "Call the get_time_in_city tool for Vienna. Do not answer with plain text.",
                  },
                ],
                responseFormat: {
                  type: "text",
                },
                toolChoice: "required",
                maxTokens: 32,
                temperature: 0,
              };

              try {
                return await client.agents.complete({
                  ...request,
                  tools: [getAgentTimeToolDefinition()],
                });
              } catch (error) {
                if (!isMistralInputValidationError(error)) {
                  throw error;
                }

                return await client.agents.complete({
                  ...request,
                  tools: [getAgentTimeToolDefinition({ legacy: true })],
                });
              }
            }, MISTRAL_REQUEST_RETRY_OPTIONS);
            await simulateToolExecutionDelay();
          },
        );

        await runOperation(
          "mistral-agents-stream-operation",
          "agents-stream",
          async () => {
            await withRetry(async () => {
              const stream = await client.agents.stream({
                agentId,
                messages: [
                  {
                    role: "user",
                    content: "Reply with exactly: agent stream",
                  },
                ],
                responseFormat: {
                  type: "text",
                },
                maxTokens: 12,
                stream: true,
                temperature: 0,
              });
              await collectAsync(stream);
            }, MISTRAL_REQUEST_RETRY_OPTIONS);
          },
        );

        await runOperation(
          "mistral-embeddings-operation",
          "embeddings-create",
          async () => {
            await withRetry(
              async () =>
                client.embeddings.create({
                  model: EMBEDDING_MODEL,
                  inputs: "braintrust mistral instrumentation",
                }),
              MISTRAL_REQUEST_RETRY_OPTIONS,
            );
          },
        );
      },
      metadata: {
        scenario: SCENARIO_NAME,
      },
      projectNameBase: "e2e-mistral-instrumentation",
      rootName: ROOT_NAME,
    });
  } finally {
    await cleanup();
  }
}

export async function runWrappedMistralInstrumentation(Mistral) {
  await runMistralInstrumentationScenario(Mistral, {
    decorateClient: wrapMistral,
  });
}

export async function runAutoMistralInstrumentation(Mistral) {
  await runMistralInstrumentationScenario(Mistral);
}
