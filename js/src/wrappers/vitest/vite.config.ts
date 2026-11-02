import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "#braintrust-platform": fileURLToPath(
        new URL("../../isomorph.ts", import.meta.url),
      ),
    },
  },
  test: {
    hookTimeout: 60_000,
    reporters: ["default"],
  },
});
