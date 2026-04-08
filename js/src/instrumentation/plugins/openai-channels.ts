import type { CompiledPrompt } from "../../logger";
import { channel, defineChannels } from "../core/channel-definitions";
import type { AsyncEndOf, StartOf } from "../core/channel-definitions";
import type { ChannelSpanInfo, SpanInfoCarrier } from "../core/types";
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatCreateParams,
  OpenAIChatStream,
  OpenAIEmbeddingCreateParams,
  OpenAIEmbeddingResponse,
  OpenAIModerationCreateParams,
  OpenAIModerationResponse,
  OpenAIResponse,
  OpenAIResponseCompactParams,
  OpenAIResponseCreateParams,
  OpenAIResponseStreamEvent,
} from "../../vendor-sdk-types/openai";

type OpenAIChatSpanInfo = NonNullable<CompiledPrompt<"chat">["span_info"]>;

export type OpenAIChannelExtras<
  TSpanInfo extends ChannelSpanInfo = ChannelSpanInfo,
> = SpanInfoCarrier<TSpanInfo> & {
  response?: Response;
};

export type OpenAIChatChannelExtras = OpenAIChannelExtras<OpenAIChatSpanInfo>;
export type OpenAIResponsesChannelExtras = OpenAIChannelExtras;

export const openAIChannels = defineChannels("openai", {
  chatCompletionsCreate: channel<
    [OpenAIChatCreateParams],
    OpenAIChatCompletion | OpenAIChatStream,
    OpenAIChatChannelExtras,
    OpenAIChatCompletionChunk
  >({
    channelName: "chat.completions.create",
    kind: "async",
  }),

  embeddingsCreate: channel<
    [OpenAIEmbeddingCreateParams],
    OpenAIEmbeddingResponse,
    OpenAIChatChannelExtras
  >({
    channelName: "embeddings.create",
    kind: "async",
  }),

  betaChatCompletionsParse: channel<
    [OpenAIChatCreateParams],
    OpenAIChatCompletion,
    OpenAIChatChannelExtras,
    OpenAIChatCompletionChunk
  >({
    channelName: "beta.chat.completions.parse",
    kind: "async",
  }),

  betaChatCompletionsStream: channel<
    [OpenAIChatCreateParams],
    unknown,
    OpenAIChatChannelExtras
  >({
    channelName: "beta.chat.completions.stream",
    kind: "sync-stream",
  }),

  moderationsCreate: channel<
    [OpenAIModerationCreateParams],
    OpenAIModerationResponse,
    OpenAIChatChannelExtras
  >({
    channelName: "moderations.create",
    kind: "async",
  }),

  responsesCreate: channel<
    [OpenAIResponseCreateParams],
    OpenAIResponse | AsyncIterable<OpenAIResponseStreamEvent>,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    channelName: "responses.create",
    kind: "async",
  }),

  responsesStream: channel<
    [OpenAIResponseCreateParams],
    unknown,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    channelName: "responses.stream",
    kind: "sync-stream",
  }),

  responsesParse: channel<
    [OpenAIResponseCreateParams],
    OpenAIResponse,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    channelName: "responses.parse",
    kind: "async",
  }),

  responsesCompact: channel<
    [OpenAIResponseCompactParams],
    OpenAIResponse,
    OpenAIResponsesChannelExtras
  >({
    channelName: "responses.compact",
    kind: "async",
  }),
});

export type OpenAIChannel =
  (typeof openAIChannels)[keyof typeof openAIChannels];

export type OpenAIAsyncChannel = Extract<OpenAIChannel, { kind: "async" }>;

export type OpenAIStartContext<TChannel extends OpenAIChannel = OpenAIChannel> =
  StartOf<TChannel>;
export type OpenAIAsyncEndEvent<
  TChannel extends OpenAIAsyncChannel = OpenAIAsyncChannel,
> = AsyncEndOf<TChannel>;
