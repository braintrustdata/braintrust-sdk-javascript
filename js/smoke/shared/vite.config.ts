import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    platform: "neutral",
    target: "es2022",
    dts: { generator: "oxc" },
    sourcemap: true,
  },
});
