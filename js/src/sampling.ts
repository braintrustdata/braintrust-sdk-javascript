import { debugLogger } from "./debug-logger";

const RANDOMNESS_BITS = 56n;
const RANDOMNESS_SCALE = 1n << RANDOMNESS_BITS;
const RANDOMNESS_SCALE_NUMBER = 2 ** 56;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/i;

let warnedInvalidTraceId = false;
let warnedInvalidTraceFlags = false;

/** Validate a public root sampling rate. */
export function validateSampleRate(sampleRate: unknown): number {
  if (
    typeof sampleRate !== "number" ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 0 ||
    sampleRate > 1
  ) {
    throw new RangeError("sampleRate must be a finite number between 0 and 1");
  }
  return sampleRate;
}

/**
 * Return whether a new trace should be recorded. The calculation is stable for
 * a trace id, allowing distributed participants and retries to make the same
 * decision without mutable random state.
 */
export function shouldSampleTraceId(
  traceId: string,
  sampleRate: number,
): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;

  const normalized = traceId.replaceAll("-", "").toLowerCase();
  if (!TRACE_ID_RE.test(normalized)) {
    if (!warnedInvalidTraceId) {
      warnedInvalidTraceId = true;
      debugLogger.warn(
        "Unable to deterministically sample an invalid trace id; recording it for compatibility.",
      );
    }
    return true;
  }

  const randomness = BigInt(`0x${normalized.slice(-14)}`);
  const keepCount = BigInt(Math.floor(sampleRate * RANDOMNESS_SCALE_NUMBER));
  const threshold = RANDOMNESS_SCALE - keepCount;
  return randomness >= threshold;
}

/** Normalize an inbound flags byte, defaulting old/custom context to sampled. */
export function normalizeTraceFlags(
  traceFlags: string | undefined,
  options?: { warnOnInvalid?: boolean },
): string {
  if (traceFlags === undefined) return "01";
  if (TRACE_FLAGS_RE.test(traceFlags)) return traceFlags.toLowerCase();

  if (options?.warnOnInvalid && !warnedInvalidTraceFlags) {
    warnedInvalidTraceFlags = true;
    debugLogger.warn(
      "Received invalid in-process trace flags; treating the trace as sampled for compatibility.",
    );
  }
  return "01";
}

/** The W3C sampled decision is the least-significant bit of the flags byte. */
export function isTraceFlagsSampled(traceFlags: string): boolean {
  return (parseInt(traceFlags, 16) & 0x01) !== 0;
}
