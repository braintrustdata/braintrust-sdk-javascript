import type { CompiledPrompt } from "../../logger";
import type {
  OpenAIMediaParams,
  OpenAIMediaResponse,
} from "../../vendor-sdk-types/openai-media";
import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  OpenAIAgentsTraceStartChannelArgs,
  OpenAIAgentsTraceState,
} from "../../openai-agents-api-types";
import type {
  CompleteOpenAIBatchTraceArgs,
  OpenAIBatchLike,
  OpenAIBatchesRetrieveTraceArgs,
  OpenAIFileLike,
  OpenAIFilesCreateTraceArgs,
} from "../../openai-batch-types";
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
import type { ChannelSpanInfo, SpanInfoCarrier } from "../core/types";

type OpenAIChatSpanInfo = NonNullable<CompiledPrompt<"chat">["span_info"]>;

type OpenAIChannelExtras<TSpanInfo extends ChannelSpanInfo = ChannelSpanInfo> =
  SpanInfoCarrier<TSpanInfo> & {
    response?: Response;
    responseInfo?: { response?: Response };
  };

type OpenAIChatChannelExtras = OpenAIChannelExtras<OpenAIChatSpanInfo>;
type OpenAIResponsesChannelExtras = OpenAIChannelExtras;

export const openAIChannels = defineInterceptor("openai", {
  imagesGenerate: channel<
    [OpenAIMediaParams, unknown?],
    PromiseLike<OpenAIMediaResponse>,
    OpenAIChannelExtras
  >({ channelName: "images.generate" }),
  imagesEdit: channel<
    [OpenAIMediaParams, unknown?],
    PromiseLike<OpenAIMediaResponse>,
    OpenAIChannelExtras
  >({ channelName: "images.edit" }),
  imagesCreateVariation: channel<
    [OpenAIMediaParams, unknown?],
    PromiseLike<OpenAIMediaResponse>,
    OpenAIChannelExtras
  >({ channelName: "images.createVariation" }),
  audioSpeechCreate: channel<
    [OpenAIMediaParams, unknown?],
    PromiseLike<OpenAIMediaResponse>,
    OpenAIChannelExtras
  >({ channelName: "audio.speech.create" }),
  audioTranscriptionsCreate: channel<
    [OpenAIMediaParams, unknown?],
    PromiseLike<OpenAIMediaResponse>,
    OpenAIChannelExtras
  >({ channelName: "audio.transcriptions.create" }),
  audioTranslationsCreate: channel<
    [OpenAIMediaParams, unknown?],
    PromiseLike<OpenAIMediaResponse>,
    OpenAIChannelExtras
  >({ channelName: "audio.translations.create" }),

  agentsTraceStart: channel<
    [OpenAIAgentsTraceStartChannelArgs],
    PromiseLike<OpenAIAgentsTraceState | null>,
    OpenAIChannelExtras
  >({
    channelName: "agents.trace.start",
  }),

  agentsTraceCapture: channel<
    [{ event: unknown; state: OpenAIAgentsTraceState | null }],
    PromiseLike<OpenAIAgentsTraceState | null>,
    OpenAIChannelExtras
  >({
    channelName: "agents.trace.capture",
  }),

  agentsTraceFail: channel<
    [{ error: unknown; state: OpenAIAgentsTraceState | null }],
    PromiseLike<OpenAIAgentsTraceState | null>,
    OpenAIChannelExtras
  >({
    channelName: "agents.trace.fail",
  }),

  filesCreateTraced: channel<
    [OpenAIFilesCreateTraceArgs],
    PromiseLike<OpenAIFileLike>,
    OpenAIChannelExtras
  >({
    channelName: "files.create-traced",
  }),

  batchesRetrieveTraced: channel<
    [OpenAIBatchesRetrieveTraceArgs],
    PromiseLike<OpenAIBatchLike>,
    OpenAIChannelExtras
  >({
    channelName: "batches.retrieve-traced",
  }),

  batchesCompleteTrace: channel<
    [CompleteOpenAIBatchTraceArgs],
    PromiseLike<void>,
    OpenAIChannelExtras
  >({
    channelName: "batches.complete-trace",
  }),

  chatCompletionsCreate: channel<
    [OpenAIChatCreateParams],
    PromiseLike<OpenAIChatCompletion | OpenAIChatStream>,
    OpenAIChatChannelExtras,
    OpenAIChatCompletionChunk
  >({
    channelName: "chat.completions.create",
  }),

  embeddingsCreate: channel<
    [OpenAIEmbeddingCreateParams],
    PromiseLike<OpenAIEmbeddingResponse>,
    OpenAIChatChannelExtras
  >({
    channelName: "embeddings.create",
  }),

  betaChatCompletionsParse: channel<
    [OpenAIChatCreateParams],
    PromiseLike<OpenAIChatCompletion>,
    OpenAIChatChannelExtras,
    OpenAIChatCompletionChunk
  >({
    channelName: "beta.chat.completions.parse",
  }),

  betaChatCompletionsStream: channel<
    [OpenAIChatCreateParams],
    unknown,
    OpenAIChatChannelExtras
  >({
    channelName: "beta.chat.completions.stream",
  }),

  moderationsCreate: channel<
    [OpenAIModerationCreateParams],
    PromiseLike<OpenAIModerationResponse>,
    OpenAIChatChannelExtras
  >({
    channelName: "moderations.create",
  }),

  responsesCreate: channel<
    [OpenAIResponseCreateParams],
    PromiseLike<OpenAIResponse | AsyncIterable<OpenAIResponseStreamEvent>>,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    channelName: "responses.create",
  }),

  responsesStream: channel<
    [OpenAIResponseCreateParams],
    unknown,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    channelName: "responses.stream",
  }),

  responsesParse: channel<
    [OpenAIResponseCreateParams],
    PromiseLike<OpenAIResponse>,
    OpenAIResponsesChannelExtras,
    OpenAIResponseStreamEvent
  >({
    channelName: "responses.parse",
  }),

  responsesCompact: channel<
    [OpenAIResponseCompactParams],
    PromiseLike<OpenAIResponse>,
    OpenAIResponsesChannelExtras
  >({
    channelName: "responses.compact",
  }),
});

export type OpenAIChannel =
  (typeof openAIChannels)[keyof typeof openAIChannels];

export type OpenAIAsyncChannel = Extract<
  OpenAIChannel,
  { __result?: PromiseLike<unknown> }
>;
