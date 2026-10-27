import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    outDir: "dist",
    dts: true,
    clean: true,
    // The codec is ESM-only; load it with import() from both builds.
    external: ["@audio/encode-opus"],
    esbuildOptions(options) {
      options.supported = { ...options.supported, "dynamic-import": true };
    },
  },
]);
