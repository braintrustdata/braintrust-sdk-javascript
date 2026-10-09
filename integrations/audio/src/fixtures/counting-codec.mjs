let calls = 0;
export function encode() {
  return {
    bytes: Uint8Array.of(++calls),
    mimeType: "audio/wav",
    sampleRate: 24000,
  };
}
