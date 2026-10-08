/** Shared call-selection clock; source and encoded audio may use other rates. */
export const CALL_SAMPLE_RATE = 24000;

/** Fractional sample frames. Round only where an integer sample boundary is needed. */
export function msToSamples(
  milliseconds: number,
  sampleRate = CALL_SAMPLE_RATE,
) {
  return milliseconds * (sampleRate / 1000);
}

export function samplesToMs(samples: number, sampleRate = CALL_SAMPLE_RATE) {
  return samples / (sampleRate / 1000);
}

/** Duration of interleaved signed 16-bit PCM. */
export function pcmBytesToMs(
  bytes: number,
  sampleRate: number,
  channels: number,
) {
  return samplesToMs(bytes / 2 / channels, sampleRate);
}
