import { isObject } from "../util";

/**
 * Describes what a segment is and where it sits on the recording timeline, in
 * terms any audio format shares. How it is encoded belongs in the segment.
 */
export interface AudioSegmentMeta {
  /** Zero-based position of this segment within its recording. */
  readonly index: number;
  /** Segment start on the recording timeline. Transforms must preserve it. */
  readonly startOffsetMs: number;
  /** Playable duration of the segment. */
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  /** Sources heard in this segment and the file channel each occupies. */
  readonly sources: readonly AudioSource[];
  /** Content type of the segment bytes, such as `audio/pcm`. */
  readonly mimeType: string;
  /** Sample or codec encoding, such as `s16le`. */
  readonly encoding: string;
  /**
   * Facts about the resulting file, such as decoding hints, published with it.
   * Use namespaced keys (`"acme.key_id"`).
   */
  readonly attributes?: Readonly<Record<string, AudioAttributeValue>>;
  /** Private values for later middleware, including binary data. Never published. */
  readonly state?: Readonly<Record<string, unknown>>;
}

type AudioAttributeValue =
  | string
  | number
  | boolean
  | null
  | readonly AudioAttributeValue[]
  | { readonly [key: string]: AudioAttributeValue };

/** A recorder source key, as given by the integration, on one file channel. */
type AudioSource = { readonly channel: number; readonly name: string };

export type AudioResult = { segment: Uint8Array; meta: AudioSegmentMeta };

/**
 * Transforms recorded audio segments, Rack/Koa style. Call `next` at most once
 * to run the rest of the stack; it resolves to the final segment and metadata.
 * Metadata is frozen: pass or return a new object, such as `{ ...meta }`.
 *
 * The stack receives PCM bytes. Each layer may pass a different segment type
 * down (`Down`), such as codec packets for a container, but the stack must end
 * with bytes, and results returned up are always bytes.
 *
 * Middleware runs once per segment on the main thread, one segment at a time per
 * recording, while recordings run concurrently. Keep per-segment state inside
 * the call. A throw or rejection omits that segment and stops the recording.
 *
 * @example
 * ```ts
 * const logEncoding: AudioMiddleware = async (segment, meta, next) => {
 *   const result = await next(segment, meta);
 *   console.log(meta.encoding, "->", result.meta.encoding);
 *   return result;
 * };
 * ```
 */
export type AudioMiddleware<In = Uint8Array, Down = In> = (
  segment: In,
  meta: AudioSegmentMeta,
  next: (segment: Down, meta: AudioSegmentMeta) => Promise<AudioResult>,
) => AudioResult | Promise<AudioResult>;

/** A stack of middleware whose segment types chain from layer to layer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Each layer has its own segment types.
export type AudioMiddlewareStack = readonly AudioMiddleware<any, any>[];

/**
 * Runs one segment through the stack and resolves to the bytes and metadata
 * that come back out. Rejects if a layer throws or breaks the contract.
 */
export function runMiddleware(
  stack: AudioMiddlewareStack,
  segment: Uint8Array,
  meta: AudioSegmentMeta,
): Promise<AudioResult> {
  const original = freeze(meta);
  const run = async (
    layer: number,
    segment: unknown,
    meta: unknown,
  ): Promise<AudioResult> => {
    const middleware = stack[layer];
    // The end of the stack returns what reached it, which must be bytes.
    if (!middleware) return validate({ segment, meta }, original);
    if (!preservesIdentity(meta, original))
      throw new Error("invalid_audio_middleware_result");
    let called = false;
    const next = (segment: unknown, meta: AudioSegmentMeta) => {
      if (called) throw new Error("next() called multiple times");
      called = true;
      const result = run(layer + 1, segment, meta);
      // Middleware may leave `next` unawaited; it still sees the rejection if awaited.
      result.catch(() => {});
      return result;
    };
    return validate(await middleware(segment, freeze(meta), next), original);
  };
  return run(0, segment, original);
}

function freeze(meta: AudioSegmentMeta): AudioSegmentMeta {
  if (Object.isFrozen(meta)) return meta;
  return Object.freeze({
    ...meta,
    sources: Object.freeze(meta.sources.map((s) => Object.freeze({ ...s }))),
    ...(meta.attributes && {
      attributes: Object.freeze({ ...meta.attributes }),
    }),
    ...(meta.state && { state: Object.freeze({ ...meta.state }) }),
  });
}

/** Segment identity and timeline placement survive every transform. */
function validate(result: unknown, original: AudioSegmentMeta): AudioResult {
  const segment = isObject(result) ? result.segment : undefined;
  const meta = isObject(result) ? result.meta : undefined;
  if (!(segment instanceof Uint8Array) || !preservesIdentity(meta, original))
    throw new Error("invalid_audio_middleware_result");
  return { segment, meta: freeze(meta) };
}

function preservesIdentity(
  meta: unknown,
  original: AudioSegmentMeta,
): meta is AudioSegmentMeta {
  return (
    isObject(meta) &&
    meta.index === original.index &&
    meta.startOffsetMs === original.startOffsetMs &&
    Array.isArray(meta.sources)
  );
}
