import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  GoogleGenAIEditImageParams,
  GoogleGenAIEditImageResponse,
  GoogleGenAIEmbedContentParams,
  GoogleGenAIEmbedContentResponse,
  GoogleGenAIGenerateContentParams,
  GoogleGenAIGenerateContentResponse,
  GoogleGenAIGenerateImagesParams,
  GoogleGenAIGenerateImagesResponse,
  GoogleGenAIGenerateVideosOperation,
  GoogleGenAIGenerateVideosParams,
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

export const googleGenAIChannels = defineInterceptor("@google/genai", {
  generateContent: channel<
    [GoogleGenAIGenerateContentParams],
    PromiseLike<GoogleGenAIGenerateContentResponse>
  >({
    channelName: "models.generateContent",
  }),
  generateContentStream: channel<
    [GoogleGenAIGenerateContentParams],
    PromiseLike<GoogleGenAIStreamingResult>,
    Record<string, unknown>,
    GoogleGenAIGenerateContentResponse
  >({
    channelName: "models.generateContentStream",
  }),
  embedContent: channel<
    [GoogleGenAIEmbedContentParams],
    PromiseLike<GoogleGenAIEmbedContentResponse>
  >({
    channelName: "models.embedContent",
  }),
  generateImages: channel<
    [GoogleGenAIGenerateImagesParams],
    PromiseLike<GoogleGenAIGenerateImagesResponse>
  >({
    channelName: "models.generateImages",
  }),
  editImage: channel<
    [GoogleGenAIEditImageParams],
    PromiseLike<GoogleGenAIEditImageResponse>
  >({
    channelName: "models.editImage",
  }),
  generateVideos: channel<
    [GoogleGenAIGenerateVideosParams],
    PromiseLike<GoogleGenAIGenerateVideosOperation>
  >({
    channelName: "models.generateVideos",
  }),
  httpResponseJson: channel<[], PromiseLike<GoogleGenAIEmbedContentResponse>>({
    channelName: "httpResponse.json",
  }),
  interactionsCreate: channel<
    [GoogleGenAIInteractionCreateParams, Record<string, unknown>?],
    PromiseLike<GoogleGenAIInteractionResult>,
    Record<string, unknown>,
    GoogleGenAIInteractionSSEEvent
  >({
    channelName: "interactions.create",
  }),
});
