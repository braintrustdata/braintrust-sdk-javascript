/**
 * @braintrust/auto-instrumentations
 *
 * Auto-instrumentation for AI SDKs using orchestrion-js and diagnostics_channel.
 *
 * This package provides:
 * - Orchestrion configs
 * - Declarative module export patch configs
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

export { openaiOrchestrionConfigs } from "./configs/openai";
export { openAICodexOrchestrionConfigs } from "./configs/openai-codex";
export { anthropicOrchestrionConfigs } from "./configs/anthropic";
export { bedrockRuntimeOrchestrionConfigs } from "./configs/bedrock-runtime";
export { aiSDKOrchestrionConfigs } from "./configs/ai-sdk";
export { claudeAgentSDKOrchestrionConfigs } from "./configs/claude-agent-sdk";
export { cursorSDKOrchestrionConfigs } from "./configs/cursor-sdk";
export { openAIAgentsCoreOrchestrionConfigs } from "./configs/openai-agents";
export { googleGenAIOrchestrionConfigs } from "./configs/google-genai";
export { huggingFaceOrchestrionConfigs } from "./configs/huggingface";
export { openRouterAgentOrchestrionConfigs } from "./configs/openrouter-agent";
export { openRouterOrchestrionConfigs } from "./configs/openrouter";
export { mistralOrchestrionConfigs } from "./configs/mistral";
export { googleADKOrchestrionConfigs } from "./configs/google-adk";
export { cohereOrchestrionConfigs } from "./configs/cohere";
export { groqOrchestrionConfigs } from "./configs/groq";
export { genkitOrchestrionConfigs } from "./configs/genkit";
export { gitHubCopilotOrchestrionConfigs } from "./configs/github-copilot";
export { langchainOrchestrionConfigs } from "./configs/langchain";
export { piCodingAgentOrchestrionConfigs } from "./configs/pi-coding-agent";
export { mastraModuleExportPatchConfigs } from "./configs/mastra";

// Re-export orchestrion configuration types from the internal fork.
export type { InstrumentationConfig } from "./orchestrion-js";
