import { channel, defineChannels } from "../core/channel-definitions";
import type {
  OpenRouterChatCompletion,
  OpenRouterChatCompletionChunk,
  OpenRouterCallModelRequest,
  OpenRouterChatCreateParams,
  OpenRouterEmbeddingCreateParams,
  OpenRouterEmbeddingResponse,
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

export const openRouterChannels = defineChannels("@openrouter/sdk", {
  chatSend: channel<
    [OpenRouterChatCreateParams],
    OpenRouterChatResult,
    Record<string, unknown>,
    OpenRouterChatCompletionChunk
  >({
    channelName: "chat.send",
    kind: "async",
  }),

  embeddingsGenerate: channel<
    [OpenRouterEmbeddingCreateParams],
    OpenRouterEmbeddingResponse
  >({
    channelName: "embeddings.generate",
    kind: "async",
  }),

  betaResponsesSend: channel<
    [OpenRouterResponsesCreateParams],
    OpenRouterResponsesResult,
    Record<string, unknown>,
    OpenRouterResponseStreamEvent
  >({
    channelName: "beta.responses.send",
    kind: "async",
  }),

  callModel: channel<[OpenRouterCallModelRequest], unknown>({
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
    kind: "async",
  }),
});
