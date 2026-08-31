import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  GoogleGenAIEmbedContentParams,
  GoogleGenAIEmbedContentResponse,
  GoogleGenAIGenerateContentParams,
  GoogleGenAIGenerateContentResponse,
  GoogleGenAIInteraction,
  GoogleGenAIInteractionCreateParams,
  GoogleGenAIInteractionSSEEvent,
} from "../../vendor-sdk-types/google-genai";
import type {
  CompleteGoogleGenAIBatchTraceArgs,
  GeminiDeveloperBatchLike,
  GoogleGenAIBatchesCreateTraceArgs,
  GoogleGenAIBatchesGetTraceArgs,
} from "../../google-genai-batch-types";

type GoogleGenAIStreamingResult =
  | GoogleGenAIGenerateContentResponse
  | AsyncIterable<GoogleGenAIGenerateContentResponse>;
type GoogleGenAIInteractionResult =
  | GoogleGenAIInteraction
  | AsyncIterable<GoogleGenAIInteractionSSEEvent>;

export const googleGenAIChannels = defineChannels(
  "@google/genai",
  {
    batchesCreateTraced: channel<
      [GoogleGenAIBatchesCreateTraceArgs],
      GeminiDeveloperBatchLike
    >({
      channelName: "batches.create-traced",
      kind: "async",
    }),
    batchesGetTraced: channel<
      [GoogleGenAIBatchesGetTraceArgs],
      GeminiDeveloperBatchLike
    >({
      channelName: "batches.get-traced",
      kind: "async",
    }),
    batchesCompleteTrace: channel<[CompleteGoogleGenAIBatchTraceArgs], void>({
      channelName: "batches.complete-trace",
      kind: "async",
    }),
    generateContent: channel<
      [GoogleGenAIGenerateContentParams],
      GoogleGenAIGenerateContentResponse
    >({
      channelName: "models.generateContent",
      kind: "async",
    }),
    generateContentStream: channel<
      [GoogleGenAIGenerateContentParams],
      GoogleGenAIStreamingResult,
      Record<string, unknown>,
      GoogleGenAIGenerateContentResponse
    >({
      channelName: "models.generateContentStream",
      kind: "async",
    }),
    embedContent: channel<
      [GoogleGenAIEmbedContentParams],
      GoogleGenAIEmbedContentResponse
    >({
      channelName: "models.embedContent",
      kind: "async",
    }),
    interactionsCreate: channel<
      [GoogleGenAIInteractionCreateParams, Record<string, unknown>?],
      GoogleGenAIInteractionResult,
      Record<string, unknown>,
      GoogleGenAIInteractionSSEEvent
    >({
      channelName: "interactions.create",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.GOOGLE_GENAI },
);
