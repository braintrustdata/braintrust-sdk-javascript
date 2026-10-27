import type { AudioMiddlewareStack } from "./audio-middleware";
import { debugLogger } from "./debug-logger";
import type { AudioEncodingConfig } from "./instrumentation/config";
import iso from "./isomorph";
import { isObject } from "../util";

const AUDIO_PACKAGE = "@braintrust/audio";
/** Set by @braintrust/audio when it loads. */
const REGISTRY = Symbol.for("braintrust.audio");
const COMPRESSION_ENV = "BRAINTRUST_AUDIO_COMPRESSION";
const PCM = "audio is recorded as uncompressed PCM, which can be very large.";

type AudioCodecs = {
  version: 1;
  createStack(config: Required<AudioEncodingConfig>): AudioMiddlewareStack;
};

/** Each integration's encoding when it is not configured. */
export type AudioEncodingDefaults = Required<AudioEncodingConfig>;

/** Loaded once per process; null when unavailable. */
let codecs: AudioCodecs | null | undefined;
const warned = new Set<string>();

/**
 * Returns the middleware that encodes one recording, or an empty stack for raw
 * PCM. Configured settings win over BRAINTRUST_AUDIO_COMPRESSION, then the
 * integration's defaults apply. Never throws: problems are warned about once
 * per process and the recording stays raw PCM.
 */
export function audioEncodingStack(
  configured: AudioEncodingConfig | undefined,
  defaults: AudioEncodingDefaults,
): AudioMiddlewareStack {
  const codec =
    configured?.codec ?? (compressionDisabled() ? PCM_CODEC : defaults.codec);
  if (codec.name === "pcm") return [];
  if (codecs === undefined) codecs = loadCodecs() ?? null;
  if (!codecs) return [];
  try {
    return codecs.createStack({
      codec,
      container: configured?.container ?? defaults.container,
    });
  } catch (error) {
    return warnOnce(`${message(error)}: ${PCM}`);
  }
}

const PCM_CODEC = { name: "pcm" } as const;

function compressionDisabled(): boolean {
  const value = iso.getEnv(COMPRESSION_ENV)?.trim().toLowerCase();
  return value === "0" || value === "false";
}

function loadCodecs(): AudioCodecs | undefined {
  if (Reflect.get(globalThis, REGISTRY) === undefined) {
    let loaded: unknown;
    try {
      loaded = iso.loadOptionalModule?.(AUDIO_PACKAGE);
    } catch (error) {
      warnOnce(
        `${AUDIO_PACKAGE} failed to load (${message(error)}): ${PCM} Reinstall ${AUDIO_PACKAGE} to compress recordings.`,
      );
      return;
    }
    if (loaded === undefined) {
      warnOnce(
        `${AUDIO_PACKAGE} is not installed: ${PCM} Install ${AUDIO_PACKAGE} to compress recordings.`,
      );
      return;
    }
  }
  const registered: unknown = Reflect.get(globalThis, REGISTRY);
  if (isAudioCodecs(registered)) return registered;
  warnOnce(
    `${AUDIO_PACKAGE} is incompatible with this version of braintrust: ${PCM} Install matching versions of braintrust and ${AUDIO_PACKAGE} to compress recordings.`,
  );
}

function isAudioCodecs(value: unknown): value is AudioCodecs {
  return (
    isObject(value) &&
    value.version === 1 &&
    typeof value.createStack === "function"
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnOnce(text: string): [] {
  if (!warned.has(text)) {
    warned.add(text);
    debugLogger.notice.warn(text);
  }
  return [];
}

export const _exportsForTestingOnly = {
  reset() {
    codecs = undefined;
    warned.clear();
  },
};
