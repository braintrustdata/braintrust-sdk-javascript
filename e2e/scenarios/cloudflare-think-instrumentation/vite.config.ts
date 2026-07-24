import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { braintrustVitePlugin } from "braintrust/vite";

const manual = process.env.CLOUDFLARE_THINK_INSTRUMENTATION === "manual";
const thinkPackageName =
  process.env.CLOUDFLARE_THINK_PACKAGE_NAME ?? "cloudflare-think-v0-latest";

export default defineConfig({
  define: {
    "process.env.CLOUDFLARE_THINK_INSTRUMENTATION": JSON.stringify(
      manual ? "manual" : "auto",
    ),
  },
  plugins: [
    ...(manual
      ? []
      : [braintrustVitePlugin({ useDiagnosticChannelCompatShim: true })]),
    cloudflare(),
  ],
  resolve: {
    alias: {
      "@cloudflare/think": thinkPackageName,
      ...(manual
        ? {
            ai: new URL("./src/wrapped-ai.ts", import.meta.url).pathname,
          }
        : {}),
    },
  },
});
