import { channel, defineChannels } from "../core/channel-definitions";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  GenerativeAIChat,
  GenerativeAIModel,
} from "../../vendor-sdk-types/google-generative-ai";

export const googleGenerativeAIChannels = defineChannels(
  "@google/generative-ai",
  {
    generateContent: channel<
      Parameters<GenerativeAIModel["generateContent"]>,
      Awaited<ReturnType<GenerativeAIModel["generateContent"]>>
    >({ channelName: "GenerativeModel.generateContent", kind: "async" }),
    generateContentStream: channel<
      Parameters<GenerativeAIModel["generateContentStream"]>,
      Awaited<ReturnType<GenerativeAIModel["generateContentStream"]>>
    >({ channelName: "GenerativeModel.generateContentStream", kind: "async" }),
    embedContent: channel<
      Parameters<GenerativeAIModel["embedContent"]>,
      Awaited<ReturnType<GenerativeAIModel["embedContent"]>>
    >({ channelName: "GenerativeModel.embedContent", kind: "async" }),
    batchEmbedContents: channel<
      Parameters<GenerativeAIModel["batchEmbedContents"]>,
      Awaited<ReturnType<GenerativeAIModel["batchEmbedContents"]>>
    >({ channelName: "GenerativeModel.batchEmbedContents", kind: "async" }),
    sendMessage: channel<
      Parameters<GenerativeAIChat["sendMessage"]>,
      Awaited<ReturnType<GenerativeAIChat["sendMessage"]>>
    >({ channelName: "ChatSession.sendMessage", kind: "async" }),
    sendMessageStream: channel<
      Parameters<GenerativeAIChat["sendMessageStream"]>,
      Awaited<ReturnType<GenerativeAIChat["sendMessageStream"]>>
    >({ channelName: "ChatSession.sendMessageStream", kind: "async" }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.GOOGLE_GENERATIVE_AI },
);
