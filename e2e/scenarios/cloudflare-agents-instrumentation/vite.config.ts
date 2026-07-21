import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { braintrustVitePlugin } from "braintrust/vite";

const agentsPackageName =
  process.env.CLOUDFLARE_AGENTS_PACKAGE_NAME ?? "agents-v0-17-latest";
const instrumentationMode =
  process.env.CLOUDFLARE_AGENTS_INSTRUMENTATION_MODE ?? "auto";
const braintrustPlugins =
  instrumentationMode === "auto"
    ? braintrustVitePlugin({ useDiagnosticChannelCompatShim: true })
    : [];

export default defineConfig({
  define: {
    __CLOUDFLARE_AGENTS_INSTRUMENTATION_MODE__:
      JSON.stringify(instrumentationMode),
  },
  plugins: [
    cloudflare(),
    ...(Array.isArray(braintrustPlugins)
      ? braintrustPlugins
      : [braintrustPlugins]),
  ],
  resolve: {
    alias: {
      agents: agentsPackageName,
    },
  },
});
