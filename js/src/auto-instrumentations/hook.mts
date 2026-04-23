/**
 * Unified loader hook for auto-instrumentation (ESM + CJS).
 *
 * Usage:
 *   node --import @braintrust/auto-instrumentations/hook.mjs app.js
 *
 * This hook performs AST transformation at load-time for BOTH ESM and CJS modules,
 * injecting TracingChannel calls into AI SDK functions.
 *
 * Many modern apps use a mix of ESM and CJS modules, so this single hook
 * handles both:
 * - ESM modules: Transformed via register() loader hook
 * - CJS modules: Transformed via ModulePatch monkey-patching Module._compile
 */

import { register } from "node:module";
import { openaiConfigs } from "./configs/openai.js";
import { anthropicConfigs } from "./configs/anthropic.js";
import { aiSDKConfigs } from "./configs/ai-sdk.js";
import { claudeAgentSDKConfigs } from "./configs/claude-agent-sdk.js";
import { googleGenAIConfigs } from "./configs/google-genai.js";
import { huggingFaceConfigs } from "./configs/huggingface.js";
import { openRouterAgentConfigs } from "./configs/openrouter-agent.js";
import { openRouterConfigs } from "./configs/openrouter.js";
import { mistralConfigs } from "./configs/mistral.js";
import { googleADKConfigs } from "./configs/google-adk.js";
import { cohereConfigs } from "./configs/cohere.js";
import { groqConfigs } from "./configs/groq.js";
import { mastraConfigs } from "./configs/mastra.js";
import { ModulePatch } from "./loader/cjs-patch.js";
import { patchTracingChannel } from "./patch-tracing-channel.js";

// Patch diagnostics_channel.tracePromise to handle APIPromise correctly.
// MUST be done here (before any SDK code runs) to fix Anthropic APIPromise incompatibility.
// Construct the module path dynamically to prevent build from stripping "node:" prefix.
const dcPath = ["node", "diagnostics_channel"].join(":");
const dc: any = await import(/* @vite-ignore */ dcPath as any);
patchTracingChannel(dc.tracingChannel);

function readDisabledIntegrations(): Set<string> {
  const raw = process.env.BRAINTRUST_DISABLE_INSTRUMENTATION;
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

function isDisabled(disabled: Set<string>, ...names: string[]): boolean {
  return names.some((name) => disabled.has(name));
}

const disabledIntegrations = readDisabledIntegrations();

// Combine all instrumentation configs.
// Respect BRAINTRUST_DISABLE_INSTRUMENTATION here too so load-time
// transformation and runtime plugins stay aligned.
const allConfigs = [
  ...(isDisabled(disabledIntegrations, "openai") ? [] : openaiConfigs),
  ...(isDisabled(disabledIntegrations, "anthropic") ? [] : anthropicConfigs),
  ...(isDisabled(disabledIntegrations, "aisdk", "ai-sdk", "vercel-ai")
    ? []
    : aiSDKConfigs),
  ...(isDisabled(disabledIntegrations, "claudeagentsdk", "claude-agent-sdk")
    ? []
    : claudeAgentSDKConfigs),
  ...(isDisabled(disabledIntegrations, "google", "google-genai")
    ? []
    : googleGenAIConfigs),
  ...(isDisabled(disabledIntegrations, "huggingface")
    ? []
    : huggingFaceConfigs),
  ...(isDisabled(disabledIntegrations, "openrouter") ? [] : openRouterConfigs),
  ...(isDisabled(disabledIntegrations, "openrouteragent", "openrouter-agent")
    ? []
    : openRouterAgentConfigs),
  ...(isDisabled(disabledIntegrations, "mistral") ? [] : mistralConfigs),
  ...(isDisabled(disabledIntegrations, "googleadk", "google-adk")
    ? []
    : googleADKConfigs),
  ...(isDisabled(disabledIntegrations, "cohere") ? [] : cohereConfigs),
  ...(isDisabled(disabledIntegrations, "groq", "groq-sdk") ? [] : groqConfigs),
  ...(isDisabled(disabledIntegrations, "mastra", "mastra-core", "@mastra/core")
    ? []
    : mastraConfigs),
];

// 1. Register ESM loader for ESM modules
register("./loader/esm-hook.mjs", {
  parentURL: import.meta.url,
  data: { instrumentations: allConfigs },
} as any);

// 2. Also load CJS register for CJS modules (many apps use mixed ESM/CJS)
try {
  const patch = new ModulePatch({ instrumentations: allConfigs });
  patch.patch();

  if (process.env.DEBUG === "@braintrust*" || process.env.DEBUG === "*") {
    console.log(
      "[Braintrust] Auto-instrumentation active (ESM + CJS) for:",
      allConfigs.map((c) => c.channelName).join(", "),
    );
  }
} catch (err) {
  // CJS patch failed, but ESM hook is still active
  if (process.env.DEBUG === "@braintrust*" || process.env.DEBUG === "*") {
    console.log(
      "[Braintrust] Auto-instrumentation active (ESM only) for:",
      allConfigs.map((c) => c.channelName).join(", "),
    );
    console.error("[Braintrust] CJS patch failed:", err);
  }
}
