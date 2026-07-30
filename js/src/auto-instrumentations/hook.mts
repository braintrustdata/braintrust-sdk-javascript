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

import { register as registerModule } from "node:module";
import {
  isInstrumentationIntegrationDisabled,
  readDisabledInstrumentationEnvConfig,
} from "../instrumentation/config.js";
import { BraintrustObservabilityExporter } from "../wrappers/mastra.js";
import { installMastraExporterFactory } from "./loader/mastra-observability-patch.js";
import { getDefaultAutoInstrumentationConfigs } from "./configs/all.js";
import { ModulePatch } from "./loader/cjs-patch.js";
import { patchTracingChannel } from "./patch-tracing-channel.js";
import registerState from "./import-in-the-middle/lib/register.mjs";
import { createHook as createImportInTheMiddleHook } from "./import-in-the-middle/create-hook.mjs";
import {
  getDefaultTopLevelImportHooks,
  installTopLevelImportHookRunner,
} from "./loader/top-level-export-patches.js";
import { installNodeTopLevelExportPatches } from "./loader/top-level-export-patches-node.js";

const BRAINTRUST_IITM_LOADER_PARAM = "braintrust-iitm-loader";
const registryImportUrl = getCanonicalHookUrl(import.meta.url);
const asyncImportHookUrl = getImportInTheMiddleLoaderUrl(registryImportUrl);
const isImportInTheMiddleLoader = hasImportInTheMiddleLoaderParam(
  import.meta.url,
);
const importInTheMiddleHook = createImportInTheMiddleHook(import.meta, {
  registerUrl: registryImportUrl,
});

export const initialize = importInTheMiddleHook.initialize;
export const resolve = importInTheMiddleHook.resolve;
export const load = importInTheMiddleHook.load;
export const register = registerState.register;

const state = ((globalThis as any)[
  Symbol.for("braintrust.applyAutoInstrumentation")
] ??= {}) as { applied?: boolean };
const alreadyApplied = state.applied;

// Patch diagnostics_channel.tracePromise to handle APIPromise correctly.
// MUST be done here (before any SDK code runs) to fix Anthropic APIPromise incompatibility.
// Construct the module path dynamically to prevent build from stripping "node:" prefix.
if (!isImportInTheMiddleLoader && !alreadyApplied) {
  const dcPath = ["node", "diagnostics_channel"].join(":");
  const dc: any = await import(/* @vite-ignore */ dcPath as any);
  patchTracingChannel(dc.tracingChannel);
}

if (!isImportInTheMiddleLoader && !alreadyApplied) {
  const allConfigs = getDefaultAutoInstrumentationConfigs();

  // Expose the Mastra exporter factory on globalThis so the loader patches
  // for `@mastra/core` / `@mastra/observability` can find it without having
  // to resolve `braintrust` from the user's module graph. Skipped when the
  // user opts out via `BRAINTRUST_DISABLE_INSTRUMENTATION=mastra`.
  const disabled = readDisabledInstrumentationEnvConfig(
    process.env.BRAINTRUST_DISABLE_INSTRUMENTATION,
  ).integrations;
  if (!isInstrumentationIntegrationDisabled(disabled, "mastra")) {
    installMastraExporterFactory(() => new BraintrustObservabilityExporter());
  }

  const topLevelImportHooks = getDefaultTopLevelImportHooks({
    disabledIntegrationConfig: disabled,
    target: "node",
  });
  installTopLevelImportHookRunner(topLevelImportHooks);
  installNodeTopLevelExportPatches({
    asyncImportHookUrl,
    hooks: topLevelImportHooks,
    registryImportUrl,
  });

  // 1. Register ESM loader for ESM modules
  registerModule("./loader/esm-hook.mjs", {
    parentURL: import.meta.url,
    data: { instrumentations: allConfigs },
  } as any);

  state.applied = true;

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
}

function hasImportInTheMiddleLoaderParam(url: string): boolean {
  try {
    return new URL(url).searchParams.has(BRAINTRUST_IITM_LOADER_PARAM);
  } catch {
    return false;
  }
}

function getCanonicalHookUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete(BRAINTRUST_IITM_LOADER_PARAM);
  parsed.hash = "";
  return parsed.href;
}

function getImportInTheMiddleLoaderUrl(canonicalUrl: string): string {
  const parsed = new URL(canonicalUrl);
  parsed.searchParams.set(BRAINTRUST_IITM_LOADER_PARAM, "true");
  return parsed.href;
}
