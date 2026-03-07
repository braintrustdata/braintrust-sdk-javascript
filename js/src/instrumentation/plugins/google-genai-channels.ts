import { channel, defineChannels } from "../core";
import type {
  GoogleGenAIGenerateContentParams,
  GoogleGenAIGenerateContentResponse,
} from "../../vendor-sdk-types/google-genai";

type GoogleGenAIStreamingResult =
  | GoogleGenAIGenerateContentResponse
  | AsyncIterable<GoogleGenAIGenerateContentResponse>;

export const googleGenAIChannels = defineChannels({
  generateContent: channel<
    [GoogleGenAIGenerateContentParams],
    GoogleGenAIGenerateContentResponse
  >({
    name: "models.generateContent",
    fullName: "orchestrion:@google/genai:models.generateContent",
    kind: "async",
  }),
  generateContentStream: channel<
    [GoogleGenAIGenerateContentParams],
    GoogleGenAIStreamingResult,
    Record<string, never>,
    GoogleGenAIGenerateContentResponse
  >({
    name: "models.generateContentStream",
    fullName: "orchestrion:@google/genai:models.generateContentStream",
    kind: "async",
  }),
});
