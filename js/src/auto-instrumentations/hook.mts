import "../auto.js";
/**
 * Unified loader hook for auto-instrumentation (ESM + CJS).
 *
 * Usage:
 *   node --import braintrust/hook.mjs app.js
 *
 * This hook performs AST transformation at load-time for BOTH ESM and CJS modules,
 * injecting global instrumentation hook calls into AI SDK functions.
 *
 * Many modern apps use a mix of ESM and CJS modules, so this single hook
 * handles both:
 * - ESM and CJS modules: Transformed via registerHooks(), or via register()
 *   on Node.js versions without safe registerHooks() support (see
 *   `supportsSyncHooks`)
 * - CJS modules compiled by loaders that replace Module._extensions (such as
 *   tsx): Transformed via patching Module._compile
 */

import {
  isInstrumentationIntegrationDisabled,
  readDisabledInstrumentationEnvConfig,
} from "../instrumentation/config.js";
import { BraintrustObservabilityExporter } from "../wrappers/mastra.js";
import { installMastraExporterFactory } from "./loader/mastra-observability-patch.js";
import { applyAutoInstrumentation } from "../node/apply-auto-instrumentation.js";

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

applyAutoInstrumentation(new URL("./loader/module-hooks.mjs", import.meta.url));
