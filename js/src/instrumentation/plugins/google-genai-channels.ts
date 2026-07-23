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

type GoogleGenAIStreamingResult =
  | GoogleGenAIGenerateContentResponse
  | AsyncIterable<GoogleGenAIGenerateContentResponse>;
type GoogleGenAIInteractionResult =
  | GoogleGenAIInteraction
  | AsyncIterable<GoogleGenAIInteractionSSEEvent>;

export const googleGenAIChannels = defineChannels(
  "@google/genai",
  {
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
