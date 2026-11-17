import { registerInstrumentation } from "../instrumentation/registrations/deepgram";
import { isObject } from "../../util";
import { debugLogger } from "../debug-logger";
import { deepgramChannels } from "../instrumentation/providers/deepgram-interceptors";
import type {
  ArgsOf,
  ReturnOf,
} from "../instrumentation/core/interceptor-definitions";
import type { DeepgramClient } from "../vendor-sdk-types/deepgram";

const clients = new WeakMap<object, object>();

/**
 * Trace finite transcription, HTTP speech, and text analysis requests from
 * @deepgram/sdk 3.13+, 4.x and 5.x. Callback and realtime APIs are excluded.
 * Audio capture requires BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS and the corresponding
 * BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS or BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS flag.
 */
export function wrapDeepgram<T>(client: T): T {
  registerInstrumentation();
  if (
    !isObject(client) ||
    !isObject(client.listen) ||
    !isObject(client.speak) ||
    !isObject(client.read)
  ) {
    debugLogger.notice.warn("Unsupported Deepgram client. Not wrapping.");
    return client;
  }
  const cached = clients.get(client);
  if (cached) return cached as T;
  const sdk = client as unknown as DeepgramClient;
  // Resolve children lazily: v3/v4 getters create a new request client on each access.
  // Reading getters against the original receiver also preserves private fields.
  const proxy = proxyDeepgram(sdk, "");
  clients.set(client, proxy);
  clients.set(proxy, proxy);
  return proxy as T;
}

function proxyDeepgram<T extends object>(client: T, path: string): T {
  const children = new WeakMap<object, object>();
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string") return value;
      const next = path ? `${path}.${property}` : property;
      if (typeof value === "function") {
        switch (next) {
          case "listen.v1.media.transcribeFile": {
            const hook = deepgramChannels.transcribeFile;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "listen.v1.media.transcribeUrl": {
            const hook = deepgramChannels.transcribeUrl;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "speak.v1.audio.generate": {
            const hook = deepgramChannels.generate;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "speak.v2.audio.generate": {
            const hook = deepgramChannels.generateV2;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "read.v1.text.analyze": {
            const hook = deepgramChannels.analyze;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "listen.prerecorded.transcribeFile": {
            const hook = deepgramChannels.legacyTranscribeFile;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "listen.prerecorded.transcribeUrl": {
            const hook = deepgramChannels.legacyTranscribeUrl;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "speak.request": {
            const hook = deepgramChannels.legacySpeak;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "read.analyzeText": {
            const hook = deepgramChannels.legacyAnalyzeText;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
          case "read.analyzeUrl": {
            const hook = deepgramChannels.legacyAnalyzeUrl;
            const method = value as (
              ...args: ArgsOf<typeof hook>
            ) => ReturnOf<typeof hook>;
            return (...args: ArgsOf<typeof hook>) =>
              hook.invoke(method, target, args, {});
          }
        }
      }
      if (
        isObject(value) &&
        Object.values(deepgramChannels).some((hook) =>
          hook.channelName.startsWith(`${next}.`),
        )
      ) {
        let child = children.get(value);
        if (!child) {
          child = proxyDeepgram(value, next);
          children.set(value, child);
        }
        return child;
      }
      return value;
    },
  });
}
