import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaChatResult,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
  OllamaGenerateResult,
} from "../../vendor-sdk-types/ollama";
import { channel, defineInterceptor } from "../core/channel-definitions";

export const ollamaChannels = defineInterceptor("ollama", {
  chat: channel<
    [OllamaChatRequest],
    PromiseLike<OllamaChatResult>,
    Record<string, unknown>,
    OllamaChatResponse
  >({
    channelName: "chat",
  }),
  generate: channel<
    [OllamaGenerateRequest],
    PromiseLike<OllamaGenerateResult>,
    Record<string, unknown>,
    OllamaGenerateResponse
  >({
    channelName: "generate",
  }),
  embed: channel<[OllamaEmbedRequest], PromiseLike<OllamaEmbedResponse>>({
    channelName: "embed",
  }),
});
