import { openRouterChannels } from "./openrouter-interceptors";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { _exportsForTestingOnly, initLogger } from "../../logger";
import { configureNode } from "../../node/config";
import { serviceTierMetadata } from "../core/service-tier";
import { openAIChannels } from "./openai-interceptors";
import { anthropicChannels } from "./anthropic-interceptors";
import { googleGenAIChannels } from "./google-genai-interceptors";
import { smithyCoreChannels } from "./bedrock-runtime-interceptors";
import { groqChannels } from "./groq-interceptors";
import { aiSDKChannels } from "./ai-sdk-interceptors";
import { aiSDKServiceTierMetadata } from "./ai-sdk-service-tier";
import { extractOpenAIBatchInput } from "./openai-span-data";

type TestChannel = {
  invoke(
    target: () => Promise<unknown>,
    receiver: undefined,
    args: [unknown],
    additional: Record<string, never>,
  ): unknown;
};

configureNode();

class ConverseCommand {
  constructor(public input: unknown) {}
}
class ConverseStreamCommand {
  constructor(public input: unknown) {}
}

const mappings = [
  {
    name: "OpenAI Chat Completions",
    channel: openAIChannels.chatCompletionsCreate,
    streamChannel: openAIChannels.chatCompletionsCreate,
    request: (tier: unknown) => ({ messages: [], service_tier: tier }),
    response: (tier: unknown) => ({ choices: [], service_tier: tier }),
    chunk: (tier: unknown) => ({ choices: [], service_tier: tier }),
  },
  {
    name: "OpenAI Responses",
    channel: openAIChannels.responsesCreate,
    streamChannel: openAIChannels.responsesCreate,
    request: (tier: unknown) => ({ input: "hello", service_tier: tier }),
    response: (tier: unknown) => ({ output: [], service_tier: tier }),
    chunk: (tier: unknown) => ({
      type: "response.created",
      response: { service_tier: tier },
    }),
  },
  {
    name: "Anthropic Messages",
    channel: anthropicChannels.messagesCreate,
    streamChannel: anthropicChannels.messagesCreate,
    request: (tier: unknown) => ({ messages: [], service_tier: tier }),
    response: (tier: unknown) => ({
      content: [],
      usage: { service_tier: tier },
    }),
    chunk: (tier: unknown) => ({
      type: "message_delta",
      usage: { service_tier: tier },
    }),
  },
  {
    name: "Google GenerateContent",
    channel: googleGenAIChannels.generateContent,
    streamChannel: googleGenAIChannels.generateContentStream,
    request: (tier: unknown) => ({
      model: "test-model",
      contents: "hello",
      config: { serviceTier: tier },
    }),
    response: (tier: unknown) => ({
      candidates: [],
      usageMetadata: { serviceTier: tier },
    }),
    chunk: (tier: unknown) => ({
      candidates: [],
      usageMetadata: { serviceTier: tier },
    }),
  },
  {
    name: "Bedrock Converse",
    channel: smithyCoreChannels.clientSend,
    streamChannel: smithyCoreChannels.clientSend,
    request: (tier: unknown, stream = false) =>
      new (stream ? ConverseStreamCommand : ConverseCommand)({
        modelId: "test-model",
        messages: [],
        serviceTier: { type: tier },
      }),
    response: (tier: unknown) => ({
      output: { message: {} },
      serviceTier: { type: tier },
    }),
    chunk: (tier: unknown) => ({ metadata: { serviceTier: { type: tier } } }),
  },
  {
    name: "Groq Chat Completions",
    channel: groqChannels.chatCompletionsCreate,
    streamChannel: groqChannels.chatCompletionsCreate,
    request: (tier: unknown) => ({ messages: [], service_tier: tier }),
    response: (tier: unknown) => ({ choices: [], service_tier: tier }),
    chunk: (tier: unknown) => ({ choices: [], service_tier: tier }),
  },
  {
    name: "OpenRouter Chat",
    channel: openRouterChannels.chatSend,
    streamChannel: openRouterChannels.chatSend,
    request: (tier: unknown) => ({
      chatGenerationParams: { messages: [], serviceTier: tier },
    }),
    response: (tier: unknown) => ({ choices: [], serviceTier: tier }),
    chunk: (tier: unknown) => ({ choices: [], serviceTier: tier }),
  },
  {
    name: "OpenRouter Responses",
    channel: openRouterChannels.betaResponsesSend,
    streamChannel: openRouterChannels.betaResponsesSend,
    request: (tier: unknown) => ({
      openResponsesRequest: { input: "hello", serviceTier: tier },
    }),
    response: (tier: unknown) => ({ output: [], serviceTier: tier }),
    chunk: (tier: unknown) => ({
      type: "response.created",
      response: { serviceTier: tier },
    }),
  },
  {
    name: "Google Interactions",
    channel: googleGenAIChannels.interactionsCreate,
    streamChannel: googleGenAIChannels.interactionsCreate,
    request: (tier: unknown) => ({
      model: "test-model",
      input: "hello",
      service_tier: tier,
    }),
    response: (tier: unknown) => ({ outputs: [], service_tier: tier }),
    chunk: (tier: unknown) => ({
      event_type: "interaction.start",
      interaction: { service_tier: tier },
    }),
  },
];

let backgroundLogger: ReturnType<
  typeof _exportsForTestingOnly.useTestBackgroundLogger
>;
beforeAll(async () => {
  await _exportsForTestingOnly.simulateLoginForTests();
});
beforeEach(() => {
  backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
  initLogger({
    projectName: "service-tier.test.ts",
    projectId: "test-project-id",
  });
});
afterEach(() => {
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

for (const mapping of mappings) {
  describe(mapping.name, () => {
    it.each([
      ["flex", "flex", "flex", "flex"],
      ["flex", "default", "flex", "default"],
      ["auto", "priority", "auto", "priority"],
      [undefined, "priority", undefined, "priority"],
      ["flex", undefined, "flex", undefined],
      [undefined, undefined, undefined, undefined],
      [null, "  ", undefined, undefined],
      [123, { type: "priority" }, undefined, undefined],
      [" STANDARD_ONLY ", " FUTURE-TIER ", "standard_only", "future-tier"],
    ])(
      "records independent tiers (%j, %j)",
      async (requested, served, expectedRequested, expectedServed) => {
        const params = mapping.request(requested);
        const before = JSON.stringify(params);
        const result = mapping.response(served);
        const channel = mapping.channel as TestChannel;
        expect(
          await channel.invoke(async () => result, undefined, [params], {}),
        ).toBe(result);
        expect(JSON.stringify(params)).toBe(before);
        const rows = (await backgroundLogger.drain()) as Array<{
          metadata: Record<string, unknown>;
          metrics?: unknown;
        }>;
        expect(rows).toHaveLength(1);
        const metadata = rows[0].metadata as Record<string, unknown>;
        expect(metadata.requested_service_tier).toBe(expectedRequested);
        expect(metadata.served_service_tier).toBe(expectedServed);
        expect(rows[0].metrics).not.toHaveProperty("served_service_tier");
      },
    );

    it.each(["complete", "cancel", "error"])(
      "retains the last observed tier on stream %s",
      async (ending) => {
        async function* chunks() {
          yield mapping.chunk("AUTO");
          yield mapping.chunk(" DEFAULT ");
          yield mapping.chunk(null);
          if (ending === "error") throw new Error("provider failed");
        }
        const iterable = chunks();
        const result =
          mapping.name === "Bedrock Converse" ? { stream: iterable } : iterable;
        const channel = mapping.streamChannel as TestChannel;
        const returned = await channel.invoke(
          async () => result,
          undefined,
          [mapping.request("FLEX", true)],
          {},
        );
        expect(returned).toBe(result);
        const consume = async () => {
          let count = 0;
          for await (const chunk of iterable) {
            expect(chunk).toBeDefined();
            if (++count === 3 && ending === "cancel") break;
          }
        };
        if (ending === "error")
          await expect(consume()).rejects.toThrow("provider failed");
        else await consume();
        const rows = (await backgroundLogger.drain()) as Array<{
          metadata: Record<string, unknown>;
          metrics?: unknown;
        }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toMatchObject({
          requested_service_tier: "flex",
          served_service_tier: "default",
        });
      },
    );

    it("retains only the requested tier on a failed call", async () => {
      const channel = mapping.channel as TestChannel;
      await expect(
        channel.invoke(
          async () => {
            throw new Error("capacity");
          },
          undefined,
          [mapping.request("flex")],
          {},
        ),
      ).rejects.toThrow("capacity");
      const rows = (await backgroundLogger.drain()) as Array<{
        metadata: Record<string, unknown>;
        metrics?: unknown;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({
        requested_service_tier: "flex",
      });
      expect(rows[0].metadata).not.toHaveProperty("served_service_tier");
    });
  });
}

it("does not infer a batch tier", () => {
  expect(
    extractOpenAIBatchInput("/v1/responses", {
      input: "hi",
      service_tier: " AUTO ",
    }).metadata,
  ).toMatchObject({ requested_service_tier: "auto" });
  expect(
    extractOpenAIBatchInput("/v1/responses", { input: "hi" }).metadata,
  ).not.toHaveProperty("served_service_tier");
  expect(serviceTierMetadata({ served: " ON_DEMAND " })).toEqual({
    served_service_tier: "on_demand",
  });
});

it.each(["openai", "anthropic", "google", "bedrock", "groq"])(
  "captures AI SDK %s model-call tiers",
  async (provider) => {
    await aiSDKChannels.modelGenerate.invoke(
      async () => ({
        content: [],
        providerMetadata: {
          [provider]: {
            serviceTier:
              provider === "bedrock" ? { type: "STANDARD" } : "STANDARD",
          },
        },
      }),
      undefined,
      [{ providerOptions: { [provider]: { serviceTier: "FLEX" } } }],
      { model: { modelId: "test-model", provider: `${provider}.chat` } },
    );
    const rows = (await backgroundLogger.drain()) as Array<{
      metadata: Record<string, unknown>;
      metrics?: unknown;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({
      requested_service_tier: "flex",
      served_service_tier: "standard",
    });
  },
);

it("uses only the active AI SDK provider's request options", () => {
  expect(
    aiSDKServiceTierMetadata(
      { openai: { serviceTier: "flex" }, anthropic: { serviceTier: "auto" } },
      "requested",
      "anthropic.messages",
    ),
  ).toEqual({ requested_service_tier: "auto" });
});

it("retains OpenAI helper stream tiers through lifecycle events and errors", async () => {
  const chat = new EventEmitter();
  expect(
    openAIChannels.betaChatCompletionsStream.invoke(
      () => chat,
      undefined,
      [{ messages: [], service_tier: "flex" }],
      {},
    ),
  ).toBe(chat);
  chat.emit("chunk", { service_tier: "priority", choices: [] });
  chat.emit("error", new Error("interrupted"));
  const responses = new EventEmitter();
  openAIChannels.responsesStream.invoke(
    () => responses,
    undefined,
    [{ input: "hello", service_tier: "auto" }],
    {},
  );
  responses.emit("event", {
    type: "response.created",
    response: { service_tier: "auto" },
  });
  responses.emit("event", {
    type: "response.completed",
    response: { service_tier: "default", output: [] },
  });
  responses.emit("event", {
    type: "response.completed",
    response: { service_tier: null, output: [] },
  });
  responses.emit("end");
  const rows = (await backgroundLogger.drain()) as Array<{
    metadata: Record<string, unknown>;
  }>;
  expect(rows.map((row) => row.metadata)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requested_service_tier: "flex",
        served_service_tier: "priority",
      }),
      expect.objectContaining({
        requested_service_tier: "auto",
        served_service_tier: "default",
      }),
    ]),
  );
});

it("keeps concurrent calls and failed attempts separate", async () => {
  await Promise.all(
    ["flex", "priority"].map(async (tier) => {
      await openAIChannels.chatCompletionsCreate
        .invoke(
          async () => {
            throw new Error("retry");
          },
          undefined,
          [{ messages: [], service_tier: tier }],
          {},
        )
        .catch(() => {});
      await openAIChannels.chatCompletionsCreate.invoke(
        async () => ({ choices: [], service_tier: tier }),
        undefined,
        [{ messages: [], service_tier: tier }],
        {},
      );
    }),
  );
  const rows = (await backgroundLogger.drain()) as Array<{
    metadata: Record<string, unknown>;
    error?: unknown;
  }>;
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row.metadata.served_service_tier).toBe(
      row.error ? undefined : row.metadata.requested_service_tier,
    );
  }
});

it("captures the AI SDK served tier from a raw response when provider metadata omits it", async () => {
  await aiSDKChannels.modelGenerate.invoke(
    async () => ({
      content: [],
      response: { body: { service_tier: " DEFAULT " } },
    }),
    undefined,
    [{}],
    { model: { modelId: "test-model", provider: "openai.chat" } },
  );
  const rows = await backgroundLogger.drain();
  expect(rows).toEqual([
    expect.objectContaining({
      metadata: expect.objectContaining({ served_service_tier: "default" }),
    }),
  ]);
});

it.each(["complete", "cancel", "error"])(
  "captures AI SDK stream tiers on %s",
  async (ending) => {
    let index = 0;
    const result = await aiSDKChannels.modelStream.invoke(
      async () => ({
        stream: new ReadableStream({
          pull(controller) {
            if (index++ === 0)
              controller.enqueue({
                type: "response-metadata",
                providerMetadata: { openai: { serviceTier: " PRIORITY " } },
              });
            else if (ending === "error")
              controller.error(new Error("stream failed"));
            else controller.close();
          },
        }),
      }),
      undefined,
      [{ providerOptions: { openai: { serviceTier: "AUTO" } } }],
      { model: { modelId: "test-model", provider: "openai.responses" } },
    );
    const reader = result.stream.getReader();
    await reader.read();
    if (ending === "cancel") await reader.cancel();
    else if (ending === "error")
      await expect(reader.read()).rejects.toThrow("stream failed");
    else await reader.read();
    const rows = await backgroundLogger.drain();
    expect(rows).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          requested_service_tier: "auto",
          served_service_tier: "priority",
        }),
      }),
    ]);
  },
);

it("captures served tiers from OpenAI Agents response spans", async () => {
  const { openAIAgentsCoreChannels } =
    await import("./openai-agents-interceptors");
  const trace = {
    type: "trace" as const,
    traceId: "trace-tier",
    name: "Trace",
    groupId: null,
  };
  const span = {
    type: "trace.span" as const,
    traceId: trace.traceId,
    spanId: "span-tier",
    parentId: null,
    startedAt: null,
    endedAt: null,
    error: null,
    spanData: {
      type: "response" as const,
      _response: { output: [], service_tier: " DEFAULT " },
    },
  };
  await openAIAgentsCoreChannels.onTraceStart.invoke(
    async () => undefined,
    undefined,
    [trace],
    {},
  );
  await openAIAgentsCoreChannels.onSpanStart.invoke(
    async () => undefined,
    undefined,
    [span],
    {},
  );
  await openAIAgentsCoreChannels.onSpanEnd.invoke(
    async () => undefined,
    undefined,
    [span],
    {},
  );
  await openAIAgentsCoreChannels.onTraceEnd.invoke(
    async () => undefined,
    undefined,
    [trace],
    {},
  );
  const rows = await backgroundLogger.drain();
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({ served_service_tier: "default" }),
      }),
    ]),
  );
});

it.each([false, true])(
  "captures Bedrock InvokeModel tiers (stream: %s)",
  async (streaming) => {
    class InvokeModelCommand {
      [key: string]: unknown;
      constructor(public input: unknown) {}
    }
    class InvokeModelWithResponseStreamCommand {
      [key: string]: unknown;
      constructor(public input: unknown) {}
    }
    const input = {
      modelId: "test-model",
      body: new TextEncoder().encode("{}"),
      serviceTier: " FLEX ",
    };
    const body = streaming
      ? (async function* () {
          yield { chunk: { bytes: new TextEncoder().encode("{}") } };
        })()
      : new TextEncoder().encode("{}");
    const result = { serviceTier: " DEFAULT ", body };
    await smithyCoreChannels.clientSend.invoke(
      async () => result,
      undefined,
      [
        streaming
          ? new InvokeModelWithResponseStreamCommand(input)
          : new InvokeModelCommand(input),
      ],
      {},
    );
    if (streaming)
      for await (const _chunk of body) {
        /* Consume the response. */
      }
    const rows = await backgroundLogger.drain();
    expect(rows).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          requested_service_tier: "flex",
          served_service_tier: "default",
        }),
      }),
    ]);
  },
);

it.each([
  ["azure.responses", { openai: { serviceTier: "flex" } }, "flex"],
  [
    "azure.responses",
    { azure: { serviceTier: "priority" }, openai: { serviceTier: "flex" } },
    "priority",
  ],
  [
    "azure.responses",
    { azure: {}, openai: { serviceTier: "flex" } },
    undefined,
  ],
  [
    "gateway",
    { gateway: { serviceTier: "priority" }, openai: { serviceTier: "flex" } },
    "priority",
  ],
  [
    "gateway",
    { anthropic: { serviceTier: "auto" }, openai: { serviceTier: "flex" } },
    "flex",
  ],
  ["openai.responses", { gateway: { serviceTier: "priority" } }, undefined],
])(
  "uses effective request options for %s: %j",
  async (provider, providerOptions, requested) => {
    await aiSDKChannels.modelGenerate.invoke(
      async () => ({ content: [] }),
      undefined,
      [{ providerOptions }],
      { model: { modelId: "openai/test-model", provider } },
    );
    const [row] = (await backgroundLogger.drain()) as Array<{
      metadata: Record<string, unknown>;
    }>;
    expect(row.metadata?.requested_service_tier).toBe(requested);
  },
);
