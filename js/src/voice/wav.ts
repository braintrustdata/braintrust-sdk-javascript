/**
 * WAV helpers.
 *
 * `pcmToWav` is a port of `_pcm_to_wav` in the Python SDK
 * (`py/src/braintrust/integrations/utils.py`), which both the LiveKit and
 * Pipecat integrations use to turn raw PCM into an attachable file. Keeping
 * the same container and the same `{prefix}_{rate}hz_{ch}ch.wav` filename
 * convention means a voice trace looks the same whichever SDK produced it.
 */

import { AudioFrame } from "./types";

/** Wrap signed 16-bit PCM in a WAV container. */
export function pcmToWav(
  pcm: Int16Array,
  { sampleRate, numChannels }: { sampleRate: number; numChannels: number },
): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = pcm.length * bytesPerSample;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  // WAV is little-endian; Int16Array is host-endian, so write explicitly
  // rather than memcpy'ing, or this breaks on a big-endian machine.
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(44 + i * bytesPerSample, pcm[i], true);
  }
  return out;
}

/** The filename convention the Python integrations already use. */
export function audioFilename(
  prefix: string,
  { sampleRate, numChannels }: { sampleRate: number; numChannels: number },
): string {
  return `${prefix}_${sampleRate}hz_${numChannels}ch.wav`;
}

/**
 * A short, audible sine tone.
 *
 * PLACEHOLDER AUDIO. This is not speech and does not correspond to anything
 * anyone said. It exists so the attachment path -- turn to span to object
 * store to a play button in the UI -- is exercised end to end before real
 * audio arrives, so that swapping in real audio later is a one-line change
 * with no plumbing left to discover.
 */
export function placeholderTone({
  seconds = 0.6,
  frequency = 440,
  sampleRate = 24000,
  amplitude = 0.25,
}: {
  seconds?: number;
  frequency?: number;
  sampleRate?: number;
  amplitude?: number;
} = {}): AudioFrame {
  const total = Math.floor(seconds * sampleRate);
  const data = new Int16Array(total);
  // Fade the first and last 5ms so it does not click on playback.
  const fade = Math.min(Math.floor(sampleRate * 0.005), Math.floor(total / 2));
  for (let i = 0; i < total; i++) {
    let gain = amplitude;
    if (i < fade) gain *= i / fade;
    else if (i >= total - fade) gain *= (total - 1 - i) / fade;
    data[i] = Math.round(
      gain * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate),
    );
  }
  return { data, sampleRate, numChannels: 1 };
}
