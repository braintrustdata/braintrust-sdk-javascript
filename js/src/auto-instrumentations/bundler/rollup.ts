/**
 * Rollup plugin for auto-instrumentation.
 *
 * Usage:
 * ```typescript
 * import { braintrustRollupPlugin } from 'braintrust/rollup';
 *
 * export default {
 *   plugins: [braintrustRollupPlugin()]
 * };
 * ```
 *
 * This plugin uses @apm-js-collab/code-transformer to perform AST transformation
 * at build-time, injecting TracingChannel calls into AI SDK functions.
 *
 * For browser builds, the plugin automatically uses 'dc-browser' for diagnostics_channel polyfill.
 * The als-browser polyfill for AsyncLocalStorage is automatically included as a dependency.
 */

import { unplugin, type BundlerPluginOptions } from "./plugin";

export type RollupPluginOptions = BundlerPluginOptions;

export const braintrustRollupPlugin = unplugin.rollup;

/**
 * @deprecated Use {@link braintrustRollupPlugin} instead.
 */
export const rollupPlugin = braintrustRollupPlugin;
