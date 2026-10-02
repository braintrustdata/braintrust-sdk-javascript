import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  GenerativeAIChat,
  GenerativeAIModel,
} from "../../vendor-sdk-types/google-generative-ai";

export const googleGenerativeAIChannels = defineInterceptor(
  "@google/generative-ai",
  {
    generateContent: channel<
      Parameters<GenerativeAIModel["generateContent"]>,
      PromiseLike<Awaited<ReturnType<GenerativeAIModel["generateContent"]>>>
    >({ channelName: "GenerativeModel.generateContent" }),
    generateContentStream: channel<
      Parameters<GenerativeAIModel["generateContentStream"]>,
      PromiseLike<
        Awaited<ReturnType<GenerativeAIModel["generateContentStream"]>>
      >
    >({ channelName: "GenerativeModel.generateContentStream" }),
    embedContent: channel<
      Parameters<GenerativeAIModel["embedContent"]>,
      PromiseLike<Awaited<ReturnType<GenerativeAIModel["embedContent"]>>>
    >({ channelName: "GenerativeModel.embedContent" }),
    batchEmbedContents: channel<
      Parameters<GenerativeAIModel["batchEmbedContents"]>,
      PromiseLike<Awaited<ReturnType<GenerativeAIModel["batchEmbedContents"]>>>
    >({ channelName: "GenerativeModel.batchEmbedContents" }),
    sendMessage: channel<
      Parameters<GenerativeAIChat["sendMessage"]>,
      PromiseLike<Awaited<ReturnType<GenerativeAIChat["sendMessage"]>>>
    >({ channelName: "ChatSession.sendMessage" }),
    sendMessageStream: channel<
      Parameters<GenerativeAIChat["sendMessageStream"]>,
      PromiseLike<Awaited<ReturnType<GenerativeAIChat["sendMessageStream"]>>>
    >({ channelName: "ChatSession.sendMessageStream" }),
  },
);
