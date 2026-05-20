import type { WebpackPluginInstance } from "unplugin";
import {
  BundlerPluginOptions,
  unplugin,
  type LegacyBundlerPluginOptions,
} from "./plugin";

export function braintrustWebpackPlugin(
  options: BundlerPluginOptions = {},
): WebpackPluginInstance {
  const { useDiagnosticChannelCompatShim = false, ...pluginOptions } = options;
  return unplugin.webpack({
    ...pluginOptions,
    browser: useDiagnosticChannelCompatShim,
  });
}

export type WebpackPluginOptions = LegacyBundlerPluginOptions;

/**
 * @deprecated Use {@link braintrustWebpackPlugin} instead. This legacy export
 * defaults to browser-compatible diagnostics channel shimming when `browser`
 * is omitted; `braintrustWebpackPlugin` defaults to Node.js diagnostics_channel
 * unless `useDiagnosticChannelCompatShim` is set to `true`.
 */
export const webpackPlugin = unplugin.webpack;
