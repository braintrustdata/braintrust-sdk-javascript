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
import { getDefaultAutoInstrumentationConfigs } from "./default-configs.js";
import { ModulePatch } from "./loader/cjs-patch.js";
import { patchTracingChannel } from "./patch-tracing-channel.js";

const state = ((globalThis as any)[
  Symbol.for("braintrust.applyInstrumentation")
] ??= {}) as { applied?: boolean };
const alreadyApplied = state.applied;

// Patch diagnostics_channel.tracePromise to handle APIPromise correctly.
// MUST be done here (before any SDK code runs) to fix Anthropic APIPromise incompatibility.
// Construct the module path dynamically to prevent build from stripping "node:" prefix.
if (!alreadyApplied) {
  const dcPath = ["node", "diagnostics_channel"].join(":");
  const dc: any = await import(/* @vite-ignore */ dcPath as any);
  patchTracingChannel(dc.tracingChannel);
}

const allConfigs = getDefaultAutoInstrumentationConfigs();

if (!alreadyApplied) {
  // 1. Register ESM loader for ESM modules
  register("./loader/esm-hook.mjs", {
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
