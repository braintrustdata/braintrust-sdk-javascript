import { ogg } from "./ogg";
import { opus, warmOpus, type OpusOptions } from "./opus";
import type { AudioMiddleware } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Each layer has its own segment types.
type AnyAudioMiddleware = AudioMiddleware<any, any>;

/** What the SDK asks for, after applying the integration's defaults. */
interface AudioConfig {
  codec: { name: string; options?: Record<string, unknown> };
  container?: { name: string; options?: Record<string, unknown> };
}

const CODECS: Record<
  string,
  (options: Record<string, unknown>) => AnyAudioMiddleware
> = {
  opus: (options) => opus(opusOptions(options)),
};
const CONTAINERS: Record<string, () => AnyAudioMiddleware> = {
  ogg: () => ogg(),
};

let warmed = false;

/**
 * Builds the middleware for one recording: the codec, then its container.
 * Throws with an explanation when the config names something unsupported.
 */
export function createStack(config: AudioConfig): AnyAudioMiddleware[] {
  const codec = lookup(CODECS, "codec", config.codec?.name);
  const container = lookup(CONTAINERS, "container", config.container?.name);
  const stack = [codec(config.codec.options ?? {}), container()];
  // Compile the codec now so the first segment does not.
  if (!warmed) {
    warmed = true;
    warmOpus().catch(() => {});
  }
  return stack;
}

function lookup<T>(table: Record<string, T>, kind: string, name: unknown): T {
  if (typeof name === "string" && Object.hasOwn(table, name))
    return table[name];
  const supported = Object.keys(table)
    .map((key) => `"${key}"`)
    .join(", ");
  throw new Error(
    name === undefined
      ? `Missing audio ${kind} (supported: ${supported})`
      : `Unknown audio ${kind} ${JSON.stringify(name)} (supported: ${supported})`,
  );
}

const APPLICATIONS = ["audio", "voip", "lowdelay"];

function opusOptions(options: Record<string, unknown>): OpusOptions {
  const { bitrate, complexity, application } = options;
  if (
    bitrate !== undefined &&
    !(typeof bitrate === "number" && bitrate >= 6_000 && bitrate <= 510_000)
  )
    throw new Error("Opus bitrate must be 6000 to 510000 bits per second");
  if (
    complexity !== undefined &&
    !(
      Number.isInteger(complexity) &&
      Number(complexity) >= 0 &&
      Number(complexity) <= 10
    )
  )
    throw new Error("Opus complexity must be an integer from 0 to 10");
  if (application !== undefined && !APPLICATIONS.includes(String(application)))
    throw new Error(
      `Opus application must be one of ${APPLICATIONS.map((a) => `"${a}"`).join(", ")}`,
    );
  return options as OpusOptions;
}
