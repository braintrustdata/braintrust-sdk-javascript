/**
 * @braintrust/auto-instrumentations
 *
 * Auto-instrumentation for AI SDKs using orchestrion-js and diagnostics_channel.
 *
 * This package provides:
 * - Instrumentation configs for orchestrion-js
 * - ESM loader hooks for load-time instrumentation
 * - CJS register for CommonJS instrumentation
 * - Bundler plugins for build-time instrumentation
 *
 * Usage:
 *
 * **ESM Loader:**
 * ```bash
 * node --import @braintrust/auto-instrumentations/hook.mjs app.js
 * ```
 *
 * **CJS Register:**
 * ```bash
 * node --require @braintrust/auto-instrumentations/register.cjs app.js
 * ```
 *
 * **Bundler Plugin (Vite):**
 * ```typescript
 * import { braintrustVitePlugin } from 'braintrust/vite';
 * export default { plugins: [braintrustVitePlugin()] };
 * ```
 */

export { openaiConfigs } from "./configs/openai";
export { openAICodexConfigs } from "./configs/openai-codex";
export { anthropicConfigs } from "./configs/anthropic";
export { aiSDKConfigs } from "./configs/ai-sdk";
export { claudeAgentSDKConfigs } from "./configs/claude-agent-sdk";
export { cursorSDKConfigs } from "./configs/cursor-sdk";
export { googleGenAIConfigs } from "./configs/google-genai";
export { huggingFaceConfigs } from "./configs/huggingface";
export { openRouterAgentConfigs } from "./configs/openrouter-agent";
export { openRouterConfigs } from "./configs/openrouter";
export { mistralConfigs } from "./configs/mistral";
export { googleADKConfigs } from "./configs/google-adk";
export { cohereConfigs } from "./configs/cohere";
export { groqConfigs } from "./configs/groq";
export { genkitConfigs } from "./configs/genkit";
export { gitHubCopilotConfigs } from "./configs/github-copilot";

// Re-export orchestrion configuration types
// Note: ModuleMetadata and FunctionQuery are properties of InstrumentationConfig,
// not separate exports from @apm-js-collab/code-transformer
export type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
