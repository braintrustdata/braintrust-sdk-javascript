import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  OpenRouterCallModelRequest,
  OpenRouterChatCompletion,
  OpenRouterChatCompletionChunk,
  OpenRouterChatCreateParams,
  OpenRouterEmbeddingCreateParams,
  OpenRouterEmbeddingResponse,
  OpenRouterRerankCreateParams,
  OpenRouterRerankResult,
  OpenRouterResponse,
  OpenRouterResponseStreamEvent,
  OpenRouterResponsesCreateParams,
} from "../../vendor-sdk-types/openrouter";

type OpenRouterChatResult =
  | OpenRouterChatCompletion
  | AsyncIterable<OpenRouterChatCompletionChunk>;

type OpenRouterResponsesResult =
  | OpenRouterResponse
  | AsyncIterable<OpenRouterResponseStreamEvent>;

export const openRouterChannels = defineInterceptor("@openrouter/sdk", {
  chatSend: channel<
    [OpenRouterChatCreateParams],
    PromiseLike<OpenRouterChatResult>,
    Record<string, unknown>,
    OpenRouterChatCompletionChunk
  >({
    channelName: "chat.send",
  }),

  embeddingsGenerate: channel<
    [OpenRouterEmbeddingCreateParams],
    PromiseLike<OpenRouterEmbeddingResponse>
  >({
    channelName: "embeddings.generate",
  }),

  rerankRerank: channel<
    [OpenRouterRerankCreateParams],
    PromiseLike<OpenRouterRerankResult>
  >({
    channelName: "rerank.rerank",
  }),

  betaResponsesSend: channel<
    [OpenRouterResponsesCreateParams],
    PromiseLike<OpenRouterResponsesResult>,
    Record<string, unknown>,
    OpenRouterResponseStreamEvent
  >({
    channelName: "beta.responses.send",
  }),

  callModel: channel<[OpenRouterCallModelRequest], unknown>({
    channelName: "callModel",
  }),

  callModelTurn: channel<
    [OpenRouterCallModelRequest | undefined],
    PromiseLike<unknown>,
    {
      step: number;
      stepType: "initial" | "continue";
    }
  >({
    channelName: "callModel.turn",
  }),

  toolExecute: channel<
    [unknown],
    unknown | AsyncIterable<unknown>,
    {
      span_info?: {
        name?: string;
      };
      toolCallId?: string;
      toolName: string;
    },
    unknown
  >({
    channelName: "tool.execute",
  }),
});
