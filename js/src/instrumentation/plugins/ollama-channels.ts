import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaChatResult,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
  OllamaEmbeddingsRequest,
  OllamaEmbeddingsResponse,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
  OllamaGenerateResult,
} from "../../vendor-sdk-types/ollama";
import { channel, defineChannels } from "../core/channel-definitions";

export const ollamaChannels = defineChannels(
  "ollama",
  {
    chat: channel<
      [OllamaChatRequest],
      OllamaChatResult,
      Record<string, unknown>,
      OllamaChatResponse
    >({
      channelName: "chat",
      kind: "async",
    }),
    generate: channel<
      [OllamaGenerateRequest],
      OllamaGenerateResult,
      Record<string, unknown>,
      OllamaGenerateResponse
    >({
      channelName: "generate",
      kind: "async",
    }),
    embed: channel<[OllamaEmbedRequest], OllamaEmbedResponse>({
      channelName: "embed",
      kind: "async",
    }),
    embeddings: channel<[OllamaEmbeddingsRequest], OllamaEmbeddingsResponse>({
      channelName: "embeddings",
      kind: "async",
    }),
  },
  { instrumentationName: INSTRUMENTATION_NAMES.OLLAMA },
);
