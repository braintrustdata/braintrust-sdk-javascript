import { channel, defineChannels } from "../core/channel-definitions";
import type {
  GoogleGenAIGenerateContentParams,
  GoogleGenAIGenerateContentResponse,
} from "../../vendor-sdk-types/google-genai";

type GoogleGenAIStreamingResult =
  | GoogleGenAIGenerateContentResponse
  | AsyncIterable<GoogleGenAIGenerateContentResponse>;

export const googleGenAIChannels = defineChannels("@google/genai", {
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
});
