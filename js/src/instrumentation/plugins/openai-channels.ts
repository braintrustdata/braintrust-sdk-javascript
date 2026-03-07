import type { CompiledPrompt } from "../../logger";
import { channel, defineChannels } from "../core";
import type { AsyncEndOf, StartOf } from "../core";
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
  OpenAIResponseCreateParams,
  OpenAIResponseStreamEvent,
} from "../../vendor-sdk-types/openai";

type OpenAIChatSpanInfo = NonNullable<CompiledPrompt<"chat">["span_info"]>;

export type OpenAIChannelExtras<TSpanInfo extends object> = {
  response?: Response;
  span_info?: TSpanInfo;
};

export type OpenAIChatChannelExtras = OpenAIChannelExtras<OpenAIChatSpanInfo>;
export type OpenAIResponsesChannelExtras = OpenAIChannelExtras<
  Record<string, unknown>
>;

export const openAIChannels = defineChannels({
  chatCompletionsCreate: channel<
    [OpenAIChatCreateParams],
    OpenAIChatCompletion | OpenAIChatStream,
    OpenAIChatChannelExtras,
    OpenAIChatCompletionChunk
  >({
    name: "chat.completions.create",
    fullName: "orchestrion:openai:chat.completions.create",
    kind: "async",
  }),

  embeddingsCreate: channel<
    [OpenAIEmbeddingCreateParams],
    OpenAIEmbeddingResponse,
    OpenAIChatChannelExtras
  >({
    name: "embeddings.create",
    fullName: "orchestrion:openai:embeddings.create",
    kind: "async",
  }),

  betaChatCompletionsParse: channel<
    [OpenAIChatCreateParams],
    OpenAIChatCompletion,
    OpenAIChatChannelExtras,
    OpenAIChatCompletionChunk
  >({
    name: "beta.chat.completions.parse",
    fullName: "orchestrion:openai:beta.chat.completions.parse",
    kind: "async",
  }),

  betaChatCompletionsStream: channel<
    [OpenAIChatCreateParams],
    unknown,
    OpenAIChatChannelExtras
  >({
    name: "beta.chat.completions.stream",
    fullName: "orchestrion:openai:beta.chat.completions.stream",
    kind: "sync-stream",
  }),

  moderationsCreate: channel<
    [OpenAIModerationCreateParams],
    OpenAIModerationResponse,
    OpenAIChatChannelExtras
  >({
    name: "moderations.create",
    fullName: "orchestrion:openai:moderations.create",
    kind: "async",
  }),

  responsesCreate: channel<
    [OpenAIResponseCreateParams],
    OpenAIResponse | AsyncIterable<OpenAIResponseStreamEvent>,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    name: "responses.create",
    fullName: "orchestrion:openai:responses.create",
    kind: "async",
  }),

  responsesStream: channel<
    [OpenAIResponseCreateParams],
    unknown,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    name: "responses.stream",
    fullName: "orchestrion:openai:responses.stream",
    kind: "sync-stream",
  }),

  responsesParse: channel<
    [OpenAIResponseCreateParams],
    OpenAIResponse,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    name: "responses.parse",
    fullName: "orchestrion:openai:responses.parse",
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
