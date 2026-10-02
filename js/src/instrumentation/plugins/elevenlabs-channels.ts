import { channel, defineInterceptor } from "../core/channel-definitions";

import type {
  ElevenLabsAudio,
  ElevenLabsSpeechArgs,
  ElevenLabsTimestampAudio,
  ElevenLabsTranscription,
  ElevenLabsTranscriptionRequest,
} from "../../vendor-sdk-types/elevenlabs";

export const elevenLabsChannels = defineInterceptor(
  "@elevenlabs/elevenlabs-js",
  {
    convert: channel<ElevenLabsSpeechArgs, PromiseLike<ElevenLabsAudio>>({
      channelName: "textToSpeech.convert",
    }),
    stream: channel<ElevenLabsSpeechArgs, PromiseLike<ElevenLabsAudio>>({
      channelName: "textToSpeech.stream",
    }),
    convertWithTimestamps: channel<
      ElevenLabsSpeechArgs,
      PromiseLike<ElevenLabsTimestampAudio>
    >({ channelName: "textToSpeech.convertWithTimestamps" }),
    streamWithTimestamps: channel<
      ElevenLabsSpeechArgs,
      PromiseLike<AsyncIterable<ElevenLabsTimestampAudio>>
    >({ channelName: "textToSpeech.streamWithTimestamps" }),
    transcribe: channel<
      [ElevenLabsTranscriptionRequest, unknown?],
      PromiseLike<ElevenLabsTranscription>
    >({ channelName: "speechToText.convert" }),
  },
);
