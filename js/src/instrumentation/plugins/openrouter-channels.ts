import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  OpenRouterChatCompletion,
  OpenRouterChatCompletionChunk,
  OpenRouterCallModelRequest,
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

export const openRouterChannels = defineChannels(
  "@openrouter/sdk",
  {
    chatSend: channel<
      [OpenRouterChatCreateParams, options?: unknown],
      OpenRouterChatResult,
      Record<string, unknown>,
      OpenRouterChatCompletionChunk
    >({
      channelName: "chat.send",
      kind: "async",
    }),

    embeddingsGenerate: channel<
      [OpenRouterEmbeddingCreateParams, options?: unknown],
      OpenRouterEmbeddingResponse
    >({
      channelName: "embeddings.generate",
      kind: "async",
    }),

    rerankRerank: channel<
      [OpenRouterRerankCreateParams, options?: unknown],
      OpenRouterRerankResult
    >({
      channelName: "rerank.rerank",
      kind: "async",
    }),

    betaResponsesSend: channel<
      [OpenRouterResponsesCreateParams, options?: unknown],
      OpenRouterResponsesResult,
      Record<string, unknown>,
      OpenRouterResponseStreamEvent
    >({
      channelName: "beta.responses.send",
      kind: "async",
    }),

    callModel: channel<
      [OpenRouterCallModelRequest, options?: unknown],
      unknown
    >({
      channelName: "callModel",
      kind: "sync-stream",
    }),

    callModelTurn: channel<
      [OpenRouterCallModelRequest | undefined],
      unknown,
      {
        step: number;
        stepType: "initial" | "continue";
      }
    >({
      channelName: "callModel.turn",
      kind: "async",
    }),

    toolExecute: channel<
      unknown[],
      unknown,
      { toolCallId?: string; toolName: string }
    >({
      channelName: "tool.execute",
      kind: "sync-stream",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.OPENROUTER },
);
