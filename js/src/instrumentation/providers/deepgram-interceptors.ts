import { channel, defineInterceptor } from "../core/interceptor-definitions";
import type {
  DeepgramArgs,
  DeepgramFileArgs,
  DeepgramFile,
  DeepgramRequest,
  DeepgramLegacyArgs,
  DeepgramResponse,
  DeepgramLegacyResponse,
  DeepgramAudio,
  DeepgramLegacyAudio,
} from "../../vendor-sdk-types/deepgram";

export const deepgramChannels = defineInterceptor("@deepgram/sdk", {
  transcribeFile: channel<DeepgramFileArgs, PromiseLike<DeepgramResponse>>({
    channelName: "listen.v1.media.transcribeFile",
  }),
  transcribeUrl: channel<DeepgramArgs, PromiseLike<DeepgramResponse>>({
    channelName: "listen.v1.media.transcribeUrl",
  }),
  generate: channel<DeepgramArgs, PromiseLike<DeepgramAudio>>({
    channelName: "speak.v1.audio.generate",
  }),
  generateV2: channel<DeepgramArgs, PromiseLike<DeepgramAudio>>({
    channelName: "speak.v2.audio.generate",
  }),
  analyze: channel<DeepgramArgs, PromiseLike<DeepgramResponse>>({
    channelName: "read.v1.text.analyze",
  }),
  legacyTranscribeFile: channel<
    [DeepgramFile, DeepgramRequest?, string?],
    PromiseLike<DeepgramLegacyResponse>
  >({ channelName: "listen.prerecorded.transcribeFile" }),
  legacyTranscribeUrl: channel<
    DeepgramLegacyArgs,
    PromiseLike<DeepgramLegacyResponse>
  >({ channelName: "listen.prerecorded.transcribeUrl" }),
  legacySpeak: channel<DeepgramLegacyArgs, PromiseLike<DeepgramLegacyAudio>>({
    channelName: "speak.request",
  }),
  legacyAnalyzeText: channel<
    DeepgramLegacyArgs,
    PromiseLike<DeepgramLegacyResponse>
  >({ channelName: "read.analyzeText" }),
  legacyAnalyzeUrl: channel<
    DeepgramLegacyArgs,
    PromiseLike<DeepgramLegacyResponse>
  >({ channelName: "read.analyzeUrl" }),
});
