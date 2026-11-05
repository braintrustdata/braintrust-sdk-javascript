import { createRequire } from "node:module";
import { cloudflare } from "@cloudflare/vite-plugin";
import { braintrustVitePlugin } from "braintrust/vite";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const agentsPackageName =
  process.env.CLOUDFLARE_AGENTS_PACKAGE_NAME ?? "agents-v0-20";
const mode = process.env.CLOUDFLARE_AI_CHAT_INSTRUMENTATION_MODE ?? "manual";
const packageName =
  process.env.CLOUDFLARE_AI_CHAT_PACKAGE_NAME ?? "cloudflare-ai-chat-v0-latest";

export default defineConfig({
  cacheDir: `.vite-${packageName}-${mode}`,
  define: {
    __BRAINTRUST_API_KEY__: JSON.stringify(process.env.BRAINTRUST_API_KEY),
    __BRAINTRUST_API_URL__: JSON.stringify(process.env.BRAINTRUST_API_URL),
    __BRAINTRUST_APP_URL__: JSON.stringify(process.env.BRAINTRUST_APP_URL),
    __BRAINTRUST_PROJECT_NAME__: JSON.stringify(
      process.env.BRAINTRUST_E2E_PROJECT_NAME,
    ),
    __BRAINTRUST_TEST_RUN_ID__: JSON.stringify(
      process.env.BRAINTRUST_E2E_RUN_ID,
    ),
    __CLOUDFLARE_AI_CHAT_MODE__: JSON.stringify(mode),
    __OPENAI_API_KEY__: JSON.stringify(process.env.OPENAI_API_KEY),
    __OPENAI_BASE_URL__: JSON.stringify(process.env.OPENAI_BASE_URL),
  },
  plugins: [
    ...(mode === "auto"
      ? [braintrustVitePlugin({ useDiagnosticChannelCompatShim: true })]
      : []),
    cloudflare({ configPath: "./wrangler.toml", inspectorPort: 0 }),
  ],
  resolve: {
    alias: [
      // AI Chat 0.9 uses agents/chat exports removed in agents 0.25.
      // Keep each lane on its compatible Agents runtime, including subpaths.
      ...(agentsPackageName !== "agents"
        ? [{ find: "agents", replacement: agentsPackageName }]
        : []),
      {
        find: /^@cloudflare\/ai-chat$/,
        replacement: require.resolve(packageName),
      },
    ],
  },
});
