/**
 * Webpack plugin for auto-instrumentation.
 *
 * Usage:
 * ```javascript
 * import { braintrustWebpackPlugin } from 'braintrust/webpack';
 *
 * export default {
 *   plugins: [braintrustWebpackPlugin()],
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

export type WebpackPluginOptions = BundlerPluginOptions;

export const braintrustWebpackPlugin = unplugin.webpack;

/**
 * @deprecated Use {@link braintrustWebpackPlugin} instead.
 */
export const webpackPlugin = braintrustWebpackPlugin;
