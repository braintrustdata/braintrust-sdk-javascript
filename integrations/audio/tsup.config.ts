import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    encoder: "src/encoder.ts",
    "audio-worker": "src/audio-worker.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  shims: true,
  clean: true,
  external: ["@audio/encode-opus"],
});
