import { isObject } from "../../util";
import { debugLogger } from "../debug-logger";
import { elevenLabsChannels } from "../instrumentation/plugins/elevenlabs-channels";
import type {
  ElevenLabsClient,
  ElevenLabsSpeechArgs,
  ElevenLabsTranscriptionRequest,
} from "../vendor-sdk-types/elevenlabs";

const clients = new WeakMap<object, object>();

/**
 * Trace an ElevenLabs client (SDK 2.67+) with Braintrust.
 *
 * Captures speech generation, timestamped/streaming audio, and request/response
 * transcription. Audio is attached as the application consumes it.
 * Webhook transcription and Speech Engine sessions are not instrumented.
 *
 * @example
 * ```ts
 * const client = wrapElevenLabs(new ElevenLabsClient());
 * const audio = await client.textToSpeech.convert(voiceId, { text, modelId });
 * for await (const chunk of audio) { playChunk(chunk); }
 * ```
 *
 */
export function wrapElevenLabs<T>(client: T): T {
  if (
    !isObject(client) ||
    !isObject(client.textToSpeech) ||
    typeof client.textToSpeech.convert !== "function"
  ) {
    debugLogger.warn("Unsupported ElevenLabs client. Not wrapping.");
    return client;
  }
  const cached = clients.get(client);
  if (cached) return cached as T;
  const sdk = client as unknown as ElevenLabsClient;
  const speech = new Proxy(sdk.textToSpeech, {
    get(target, prop, receiver) {
      switch (prop) {
        case "convert":
        case "stream":
          return (...args: ElevenLabsSpeechArgs) =>
            elevenLabsChannels[prop].invoke(target[prop], target, args, {});
        case "convertWithTimestamps":
          return (...args: ElevenLabsSpeechArgs) =>
            elevenLabsChannels.convertWithTimestamps.invoke(
              target.convertWithTimestamps,
              target,
              args,
              {},
            );
        case "streamWithTimestamps":
          return (...args: ElevenLabsSpeechArgs) =>
            elevenLabsChannels.streamWithTimestamps.invoke(
              target.streamWithTimestamps,
              target,
              args,
              {},
            );
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
  const transcription = new Proxy(sdk.speechToText, {
    get(target, prop, receiver) {
      if (prop === "convert")
        return (request: ElevenLabsTranscriptionRequest, options?: unknown) =>
          elevenLabsChannels.transcribe.invoke(
            target.convert,
            target,
            [request, options],
            {},
          );
      return Reflect.get(target, prop, receiver);
    },
  });
  const proxy = new Proxy(sdk, {
    get(target, prop, receiver) {
      if (prop === "textToSpeech") return speech;
      if (prop === "speechToText") return transcription;
      return Reflect.get(target, prop, receiver);
    },
  });
  clients.set(client, proxy);
  clients.set(proxy, proxy);
  return proxy as T;
}
