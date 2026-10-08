import { channel, defineInterceptor } from "../core/channel-definitions";

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

export const huggingFaceChannels = defineInterceptor("@huggingface/inference", {
  chatCompletion: channel<
    [HuggingFaceChatCompletionParams],
    PromiseLike<HuggingFaceChatCompletion>
  >({
    channelName: "chatCompletion",
  }),

  chatCompletionStream: channel<
    [HuggingFaceChatCompletionParams],
    AsyncIterable<HuggingFaceChatCompletionChunk>,
    Record<string, unknown>,
    HuggingFaceChatCompletionChunk
  >({
    channelName: "chatCompletionStream",
  }),

  textGeneration: channel<
    [HuggingFaceTextGenerationParams],
    PromiseLike<HuggingFaceTextGenerationOutput>
  >({
    channelName: "textGeneration",
  }),

  textGenerationStream: channel<
    [HuggingFaceTextGenerationParams],
    AsyncIterable<HuggingFaceTextGenerationStreamOutput>,
    Record<string, unknown>,
    HuggingFaceTextGenerationStreamOutput
  >({
    channelName: "textGenerationStream",
  }),

  featureExtraction: channel<
    [HuggingFaceFeatureExtractionParams],
    PromiseLike<HuggingFaceFeatureExtractionOutput>
  >({
    channelName: "featureExtraction",
  }),
});
