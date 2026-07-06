import { wrapAISDK } from "braintrust";
import { z } from "zod";
import {
  runMain,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "ai-sdk-instrumentation-root";
export const SCENARIO_NAME = "ai-sdk-instrumentation";
export const AI_SDK_SCENARIO_TIMEOUT_MS = 120_000;
const CACHE_PROMPT_PREFIX = "braintrust cache prefix ".repeat(900).trim();
const OPENAI_CACHE_KEY = "braintrust-ai-sdk-e2e-cache";
const CACHE_FILL_DELAY_MS = 5_000;
export const AI_SDK_SCENARIO_SPECS = [
  {
    autoEntry: "scenario.ai-sdk-v3.mjs",
    dependencyName: "ai-sdk-v3",
    maxTokensKey: "maxTokens",
    openaiModuleName: "ai-sdk-openai-v3",
    packageName: "ai-sdk-v3",
    snapshotName: "ai-sdk-v3",
    supportsEmbedMany: false,
    supportsProviderCacheAssertions: false,
    supportsGenerateObject: true,
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: false,
    toolSchemaKey: "parameters",
    wrapperEntry: "scenario.ai-sdk-v3.ts",
  },
  {
    autoEntry: "scenario.ai-sdk-v4.mjs",
    dependencyName: "ai-sdk-v4",
    maxTokensKey: "maxTokens",
    openaiModuleName: "ai-sdk-openai-v4",
    packageName: "ai-sdk-v4",
    snapshotName: "ai-sdk-v4",
    supportsEmbedMany: false,
    supportsProviderCacheAssertions: false,
    supportsGenerateObject: true,
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: false,
    toolSchemaKey: "parameters",
    wrapperEntry: "scenario.ai-sdk-v4.ts",
  },
  {
    agentClassExport: "Experimental_Agent",
    agentSpanName: "Agent",
    autoEntry: "scenario.ai-sdk-v5.mjs",
    cohereModuleName: "ai-sdk-cohere-v5",
    dependencyName: "ai-sdk-v5",
    maxTokensKey: "maxOutputTokens",
    openaiModuleName: "ai-sdk-openai-v5",
    packageName: "ai-sdk-v5",
    snapshotName: "ai-sdk-v5",
    supportsEmbedMany: false,
    supportsProviderCacheAssertions: true,
    supportsGenerateObject: true,
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
    wrapperEntry: "scenario.ai-sdk-v5.ts",
  },
  {
    agentClassExport: "ToolLoopAgent",
    agentSpanName: "ToolLoopAgent",
    autoEntry: "scenario.mjs",
    cohereModuleName: "ai-sdk-cohere-v6",
    dependencyName: "ai-sdk-v6",
    maxTokensKey: "maxOutputTokens",
    openaiModuleName: "ai-sdk-openai-v6",
    packageName: "ai-sdk-v6",
    snapshotName: "ai-sdk-v6",
    supportsAgentToolLoop: true,
    supportsEmbedMany: false,
    supportsProviderCacheAssertions: true,
    supportsGenerateObject: true,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
    wrapperEntry: "scenario.ts",
  },
  {
    agentClassExport: "ToolLoopAgent",
    autoEntry: "scenario.ai-sdk-v7.mjs",
    dependencyName: "ai-sdk-v7",
    maxTokensKey: "maxOutputTokens",
    openaiModuleName: "ai-sdk-openai-v7",
    packageName: "ai-sdk-v7",
    snapshotName: "ai-sdk-v7",
    supportsAgentToolLoop: true,
    supportsDenyOutputOverrideScenario: false,
    supportsEmbedMany: true,
    supportsGenerateObject: true,
    supportsOpenAICacheScenario: false,
    supportsOutputObjectScenario: true,
    supportsProviderCacheAssertions: false,
    supportsRerank: false,
    supportsStreamObject: true,
    supportsToolExecution: true,
    toolSchemaKey: "inputSchema",
    wrapperEntry: "scenario.ai-sdk-v7.ts",
    wrapperSnapshotSuffix: "explicit",
    wrapperTestName: "explicit telemetry",
  },
];

function tokenLimit(key, value) {
  return { [key]: value };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DENY_OUTPUT_PATHS_SYMBOL = Symbol.for(
  "braintrust.ai-sdk.deny-output-paths",
);

function parseMajorVersion(version) {
  const parsed = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createOutputObjectIfSupported(ai) {
  try {
    if (
      ai &&
      typeof ai === "object" &&
      ai.Output &&
      typeof ai.Output.object === "function"
    ) {
      return ai.Output.object({
        schema: z.object({
          answer: z.string(),
        }),
      });
    }
  } catch {
    // Ignore unsupported Output.object variants.
  }

  return undefined;
}

async function assertOutputObjectResponseFormatShape(ai, sdkMajorVersion) {
  const outputSchema = ai.Output.object({
    schema: z.object({
      name: z.string().describe("A name"),
    }),
  });

  if (sdkMajorVersion === 5) {
    if (
      outputSchema.responseFormat instanceof Promise ||
      typeof outputSchema.responseFormat !== "object" ||
      outputSchema.responseFormat?.type !== "json" ||
      !outputSchema.responseFormat?.schema
    ) {
      throw new Error(
        "Expected AI SDK v5 Output.object responseFormat to be a resolved JSON object",
      );
    }
    return;
  }

  if (sdkMajorVersion >= 6) {
    if (!(outputSchema.responseFormat instanceof Promise)) {
      throw new Error(
        "Expected AI SDK v6 Output.object responseFormat to be a Promise",
      );
    }
    const resolved = await outputSchema.responseFormat;
    if (resolved?.type !== "json" || !resolved?.schema) {
      throw new Error(
        "Expected AI SDK v6 Output.object responseFormat promise to resolve to a JSON schema",
      );
    }
  }
}

function createWeatherTool(ai, schemaKey) {
  const zodSchema = z.object({
    location: z.string().describe("The city and country"),
  });

  return ai.tool({
    description: "Get the weather for a location",
    [schemaKey]: zodSchema,
    execute: async (args) =>
      JSON.stringify({
        condition: "sunny",
        location: args.location,
        temperatureC: 22,
      }),
  });
}

async function runAISDKInstrumentationScenario(
  options,
  { decorateAI, flushCount, flushDelayMs } = {},
) {
  const instrumentedAI = decorateAI ? decorateAI(options.ai) : options.ai;
  const openai =
    process.env.OPENAI_BASE_URL && options.createOpenAI
      ? options.createOpenAI({ baseURL: process.env.OPENAI_BASE_URL })
      : options.openai;
  const anthropicBaseURL = process.env.ANTHROPIC_BASE_URL
    ? `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, "")}/v1`
    : undefined;
  const anthropic =
    anthropicBaseURL && options.createAnthropic
      ? options.createAnthropic({ baseURL: anthropicBaseURL })
      : options.anthropic;
  const cohereBaseURL = process.env.COHERE_BASE_URL
    ? `${process.env.COHERE_BASE_URL.replace(/\/+$/, "")}/v2`
    : undefined;
  const cohere =
    cohereBaseURL && options.createCohere
      ? options.createCohere({ baseURL: cohereBaseURL })
      : options.cohere;
  const openaiModel = openai("gpt-4o-mini-2024-07-18");
  const anthropicModel = anthropic?.("claude-haiku-4-5");
  const openaiEmbeddingModel = openai.textEmbeddingModel(
    "text-embedding-3-small",
  );
  const cohereRerankModel =
    cohere && typeof cohere.reranking === "function"
      ? cohere.reranking("rerank-v3.5")
      : undefined;
  const sdkMajorVersion = parseMajorVersion(options.sdkVersion);
  const supportsRichInputScenarios = sdkMajorVersion >= 5;
  const supportsDenyOutputOverrideScenario =
    options.supportsDenyOutputOverrideScenario ?? supportsRichInputScenarios;
  const supportsOpenAICacheScenario =
    options.supportsOpenAICacheScenario ?? sdkMajorVersion >= 5;
  const supportsOutputObjectScenario =
    options.supportsOutputObjectScenario ?? true;
  const outputObject = createOutputObjectIfSupported(options.ai);

  await runTracedScenario({
    callback: async () => {
      await runOperation("ai-sdk-generate-operation", "generate", async () => {
        await instrumentedAI.generateText({
          model: openaiModel,
          prompt: "Reply with the single token PARIS and no punctuation.",
          temperature: 0,
          ...tokenLimit(options.maxTokensKey, 24),
        });
      });

      if (outputObject && supportsOutputObjectScenario) {
        if (sdkMajorVersion >= 5) {
          await runOperation(
            "ai-sdk-output-object-response-format-operation",
            "output-object-response-format",
            async () => {
              await assertOutputObjectResponseFormatShape(
                options.ai,
                sdkMajorVersion,
              );
            },
          );
        }

        await runOperation(
          "ai-sdk-output-object-operation",
          "output-object",
          async () => {
            await instrumentedAI.generateText({
              model: openaiModel,
              prompt:
                "Return a short answer for 2 + 2. Keep the answer concise.",
              output: outputObject,
              experimental_output: outputObject,
              temperature: 0,
              ...tokenLimit(options.maxTokensKey, 32),
            });
          },
        );
      }

      await runOperation("ai-sdk-stream-operation", "stream", async () => {
        const result = await instrumentedAI.streamText({
          model: openaiModel,
          prompt: "Count from 1 to 3 and include the words one two three.",
          temperature: 0,
          ...tokenLimit(options.maxTokensKey, 32),
        });
        for await (const _chunk of result.textStream) {
        }
      });

      await runOperation("ai-sdk-embed-operation", "embed", async () => {
        await instrumentedAI.embed({
          model: openaiEmbeddingModel,
          value: "Paris is the capital of France.",
        });
      });

      if (options.supportsEmbedMany !== false) {
        await runOperation(
          "ai-sdk-embed-many-operation",
          "embed-many",
          async () => {
            await instrumentedAI.embedMany({
              model: openaiEmbeddingModel,
              values: [
                "Paris is in France.",
                "Berlin is in Germany.",
                "Vienna is in Austria.",
              ],
            });
          },
        );
      }

      if (
        options.supportsRerank !== false &&
        typeof instrumentedAI.rerank === "function" &&
        cohereRerankModel
      ) {
        await runOperation("ai-sdk-rerank-operation", "rerank", async () => {
          await instrumentedAI.rerank({
            documents: [
              "Athens is in Greece.",
              "Paris is in France.",
              "Lima is in Peru.",
            ],
            model: cohereRerankModel,
            query: "Which document is about France?",
            topN: 2,
          });
        });
      }

      await runOperation("ai-sdk-tool-operation", "tool", async () => {
        const toolRequest = {
          model: openaiModel,
          prompt:
            "Use the get_weather tool for Paris, France. If you do not call the tool, the answer is invalid.",
          system:
            "You must inspect live weather via the provided get_weather tool before responding.",
          temperature: 0,
          tools: {
            get_weather: createWeatherTool(options.ai, options.toolSchemaKey),
          },
          ...tokenLimit(options.maxTokensKey, 128),
        };

        if (options.supportsToolExecution) {
          toolRequest.toolChoice = "required";
          toolRequest.stopWhen = options.ai.stepCountIs(4);
        }

        await instrumentedAI.generateText(toolRequest);
      });

      if (supportsOpenAICacheScenario) {
        const prompt = `${CACHE_PROMPT_PREFIX}\n\nReply with exactly CACHE_OK and nothing else.`;
        const openaiCacheRequest = {
          model: openaiModel,
          prompt,
          providerOptions: {
            openai: {
              promptCacheKey: OPENAI_CACHE_KEY,
            },
          },
          temperature: 0,
          ...tokenLimit(options.maxTokensKey, 24),
        };

        await options.ai.generateText(openaiCacheRequest);
        await sleep(CACHE_FILL_DELAY_MS);

        await runOperation(
          "ai-sdk-openai-cache-operation",
          "openai-cache",
          async () => {
            for (let index = 0; index < 2; index++) {
              await instrumentedAI.generateText(openaiCacheRequest);
              if (index < 1) {
                await sleep(CACHE_FILL_DELAY_MS);
              }
            }
          },
        );
      }

      if (anthropicModel) {
        const messages = [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${CACHE_PROMPT_PREFIX}\n\nReply with exactly CACHE_OK and nothing else.`,
              },
            ],
            providerOptions: {
              anthropic: {
                cacheControl: { type: "ephemeral" },
              },
            },
          },
        ];
        const anthropicCacheRequest = {
          model: anthropicModel,
          messages,
          temperature: 0,
          ...tokenLimit(options.maxTokensKey, 24),
        };

        await options.ai.generateText(anthropicCacheRequest);
        await sleep(CACHE_FILL_DELAY_MS);

        await runOperation(
          "ai-sdk-anthropic-cache-operation",
          "anthropic-cache",
          async () => {
            for (let index = 0; index < 2; index++) {
              await instrumentedAI.generateText(anthropicCacheRequest);
              if (index < 1) {
                await sleep(CACHE_FILL_DELAY_MS);
              }
            }
          },
        );
      }

      if (supportsDenyOutputOverrideScenario) {
        await runOperation(
          "ai-sdk-deny-output-override-operation",
          "deny-output-override",
          async () => {
            const params = {
              model: openaiModel,
              prompt: "Reply with the word DENIED and nothing else.",
              temperature: 0,
              ...tokenLimit(options.maxTokensKey, 24),
            };
            params[DENY_OUTPUT_PATHS_SYMBOL] = ["text", "_output"];
            await instrumentedAI.generateText(params);
          },
        );
      }

      if (options.supportsGenerateObject) {
        await runOperation(
          "ai-sdk-generate-object-operation",
          "generate-object",
          async () => {
            await instrumentedAI.generateObject({
              model: openaiModel,
              prompt: 'Return JSON with {"city":"Paris"}.',
              schema: z.object({
                city: z.string(),
              }),
              temperature: 0,
              ...tokenLimit(options.maxTokensKey, 32),
            });
          },
        );
      }

      if (options.supportsStreamObject) {
        await runOperation(
          "ai-sdk-stream-object-operation",
          "stream-object",
          async () => {
            const result = await instrumentedAI.streamObject({
              model: openaiModel,
              prompt: 'Stream JSON with {"city":"Paris"}.',
              schema: z.object({
                city: z.string(),
              }),
              temperature: 0,
              ...tokenLimit(options.maxTokensKey, 32),
            });
            for await (const _partial of result.partialObjectStream) {
            }
            await result.object;
          },
        );
      }

      if (options.agentClassExport) {
        await runOperation(
          "ai-sdk-agent-generate-operation",
          "agent-generate",
          async () => {
            const AgentClass = instrumentedAI[options.agentClassExport];
            const agent = new AgentClass({
              model: openaiModel,
              system: "You are a terse assistant.",
            });
            await agent.generate({
              messages: [
                {
                  role: "user",
                  content: "Reply with exactly HELLO and no punctuation.",
                },
              ],
              ...tokenLimit(options.maxTokensKey, 24),
            });
          },
        );

        await runOperation(
          "ai-sdk-agent-stream-operation",
          "agent-stream",
          async () => {
            const AgentClass = instrumentedAI[options.agentClassExport];
            const agent = new AgentClass({
              model: openaiModel,
              system: "You are a terse assistant.",
            });
            const result = await agent.stream({
              messages: [
                {
                  role: "user",
                  content:
                    "Reply with exactly STREAM HELLO and no punctuation.",
                },
              ],
              ...tokenLimit(options.maxTokensKey, 24),
            });
            for await (const _chunk of result.textStream) {
            }
          },
        );

        if (options.supportsAgentToolLoop) {
          await runOperation(
            "ai-sdk-agent-tool-loop-operation",
            "agent-tool-loop",
            async () => {
              const AgentClass = instrumentedAI[options.agentClassExport];
              const agent = new AgentClass({
                model: openaiModel,
                instructions:
                  "You are a shopping assistant. Use the tools before answering pricing questions.",
                tools: {
                  get_store_price: options.ai.tool({
                    description: "Get the price of an item at a store",
                    [options.toolSchemaKey]: z.object({
                      item: z.string().describe("The item to price"),
                      store: z.string().describe("The store name"),
                    }),
                    execute: async (args) =>
                      JSON.stringify({
                        item: args.item,
                        price:
                          args.store === "StoreA"
                            ? 999
                            : args.store === "StoreB"
                              ? 1099
                              : 0,
                        store: args.store,
                      }),
                  }),
                  apply_discount: options.ai.tool({
                    description: "Apply a discount code to a total",
                    [options.toolSchemaKey]: z.object({
                      discountCode: z
                        .string()
                        .describe("The discount code to apply"),
                      total: z.number().describe("The original total"),
                    }),
                    execute: async (args) =>
                      JSON.stringify({
                        discountCode: args.discountCode,
                        finalTotal:
                          args.discountCode === "SAVE20"
                            ? args.total * 0.8
                            : args.total,
                        originalTotal: args.total,
                      }),
                  }),
                },
                stopWhen: options.ai.stepCountIs(6),
                temperature: 0,
              });

              await agent.generate({
                messages: [
                  {
                    role: "user",
                    content:
                      "I need help comparing laptop prices before checkout.",
                  },
                  {
                    role: "assistant",
                    content:
                      "I can compare store prices and apply a discount code.",
                  },
                  {
                    role: "user",
                    content:
                      "Call get_store_price for a laptop at StoreA and StoreB, then call apply_discount with code SAVE20 for the cheaper price. Finish with the discounted total.",
                  },
                ],
                ...tokenLimit(options.maxTokensKey, 256),
              });
            },
          );
        }
      }
    },
    flushCount,
    flushDelayMs,
    metadata: {
      aiSdkVersion: options.sdkVersion,
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-ai-sdk-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedAISDKInstrumentation(options) {
  await runAISDKInstrumentationScenario(options, {
    decorateAI: wrapAISDK,
  });
}

export async function runAutoAISDKInstrumentation(options) {
  await runAISDKInstrumentationScenario(options, {
    flushCount: 2,
    flushDelayMs: 100,
  });
}

export function runAutoAISDKInstrumentationOrExit(options) {
  runMain(async () => runAutoAISDKInstrumentation(options));
}
