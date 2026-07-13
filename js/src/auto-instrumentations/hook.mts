/**
 * Unified loader hook for auto-instrumentation (ESM + CJS).
 *
 * Usage:
 *   node --import @braintrust/auto-instrumentations/hook.mjs app.js
 */

import { register as registerModule } from "node:module";
import { readDisabledInstrumentationEnvConfig } from "../instrumentation/config.js";
import { createHook as createImportInTheMiddleHook } from "./import-in-the-middle/create-hook.mjs";
import registerState from "./import-in-the-middle/lib/register.mjs";
import {
  getDefaultModuleExportPatchConfigs,
  getDefaultOrchestrionConfigs,
} from "./configs/all.js";
import { ModulePatch } from "./loader/cjs.js";
import { nodeModuleExportPatchRuntime } from "./loader/module-hooks/node-runtime.js";
import { installModuleExportPatchRunner } from "./loader/module-hooks/registry.js";
import { installNodeModuleExportHooks } from "./loader/module-hooks/node.js";
import { patchTracingChannel } from "./patch-tracing-channel.js";

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
export default registerState;

const state = ((globalThis as any)[
  Symbol.for("braintrust.applyAutoInstrumentation")
] ??= {}) as { applied?: boolean };
const alreadyApplied = state.applied;

// Query-mode imports expose IITM's loader API without bootstrapping Braintrust
// again when module.register() loads this file with its private query marker.
if (!isImportInTheMiddleLoader && !alreadyApplied) {
  const dcPath = ["node", "diagnostics_channel"].join(":");
  const dc: any = await import(/* @vite-ignore */ dcPath as any);
  patchTracingChannel(dc.tracingChannel);
}

if (!isImportInTheMiddleLoader && !alreadyApplied) {
  const disabled = readDisabledInstrumentationEnvConfig(
    process.env.BRAINTRUST_DISABLE_INSTRUMENTATION,
  ).integrations;
  const orchestrionConfigs = getDefaultOrchestrionConfigs({
    disabledIntegrationConfig: disabled,
  });
  const moduleExportPatchConfigs = getDefaultModuleExportPatchConfigs({
    disabledIntegrationConfig: disabled,
    target: "node",
  });

  installModuleExportPatchRunner(
    moduleExportPatchConfigs,
    nodeModuleExportPatchRuntime,
  );
  installNodeModuleExportHooks({
    asyncImportHookUrl,
    configs: moduleExportPatchConfigs,
    registryImportUrl,
  });

  registerModule("./loader/esm.mjs", {
    parentURL: import.meta.url,
    data: { instrumentations: orchestrionConfigs },
  } as any);

  state.applied = true;

  try {
    const patch = new ModulePatch({ instrumentations: orchestrionConfigs });
    patch.patch();

    if (process.env.DEBUG === "@braintrust*" || process.env.DEBUG === "*") {
      console.log(
        "[Braintrust] Auto-instrumentation active (ESM + CJS) for:",
        orchestrionConfigs.map((config) => config.channelName).join(", "),
      );
    }
  } catch (err) {
    if (process.env.DEBUG === "@braintrust*" || process.env.DEBUG === "*") {
      console.log(
        "[Braintrust] Auto-instrumentation active (ESM only) for:",
        orchestrionConfigs.map((config) => config.channelName).join(", "),
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
