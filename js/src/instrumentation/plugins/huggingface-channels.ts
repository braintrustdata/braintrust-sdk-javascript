import { channel, defineChannels } from "../core/channel-definitions";
import type {
  HuggingFaceChatCompletion,
  HuggingFaceChatCompletionChunk,
  HuggingFaceChatCompletionParams,
  HuggingFaceFeatureExtractionOutput,
  HuggingFaceFeatureExtractionParams,
  HuggingFaceTextGenerationOutput,
  HuggingFaceTextGenerationParams,
  HuggingFaceTextGenerationStreamOutput,
} from "../../vendor-sdk-types/huggingface";

export const huggingFaceChannels = defineChannels("@huggingface/inference", {
  chatCompletion: channel<
    [HuggingFaceChatCompletionParams],
    HuggingFaceChatCompletion
  >({
    channelName: "chatCompletion",
    kind: "async",
  }),

  chatCompletionStream: channel<
    [HuggingFaceChatCompletionParams],
    AsyncIterable<HuggingFaceChatCompletionChunk>,
    Record<string, unknown>,
    HuggingFaceChatCompletionChunk
  >({
    channelName: "chatCompletionStream",
    kind: "sync-stream",
  }),

  textGeneration: channel<
    [HuggingFaceTextGenerationParams],
    HuggingFaceTextGenerationOutput
  >({
    channelName: "textGeneration",
    kind: "async",
  }),

  textGenerationStream: channel<
    [HuggingFaceTextGenerationParams],
    AsyncIterable<HuggingFaceTextGenerationStreamOutput>,
    Record<string, unknown>,
    HuggingFaceTextGenerationStreamOutput
  >({
    channelName: "textGenerationStream",
    kind: "sync-stream",
  }),

  featureExtraction: channel<
    [HuggingFaceFeatureExtractionParams],
    HuggingFaceFeatureExtractionOutput
  >({
    channelName: "featureExtraction",
    kind: "async",
  }),
});
