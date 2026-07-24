/**
 * Unified loader hook for auto-instrumentation (ESM + CJS).
 *
 * Usage:
 *   node --import @braintrust/auto-instrumentations/hook.mjs app.js
 *
 * This hook performs AST transformation at load-time for BOTH ESM and CJS modules,
 * injecting global instrumentation hook calls into AI SDK functions.
 *
 * Many modern apps use a mix of ESM and CJS modules, so this single hook
 * handles both:
 * - ESM modules: Transformed via register() loader hook
 * - CJS modules: Transformed via ModulePatch monkey-patching Module._compile
 */

import { register } from "node:module";
import {
  isInstrumentationIntegrationDisabled,
  readDisabledInstrumentationEnvConfig,
} from "../instrumentation/config.js";
import { BraintrustObservabilityExporter } from "../wrappers/mastra.js";
import { installMastraExporterFactory } from "./loader/mastra-observability-patch.js";
import { getDefaultAutoInstrumentationConfigs } from "./configs/all.js";
import { ModulePatch } from "./loader/cjs-patch.js";

const state = ((globalThis as any)[
  Symbol.for("braintrust.applyAutoInstrumentation")
] ??= {}) as { applied?: boolean };
const alreadyApplied = state.applied;

if (!alreadyApplied) {
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
