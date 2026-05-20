import type { EsbuildPlugin } from "unplugin";
import {
  BundlerPluginOptions,
  unplugin,
  type LegacyBundlerPluginOptions,
} from "./plugin";

export function braintrustEsbuildPlugin(
  options: BundlerPluginOptions = {},
): EsbuildPlugin {
  const { useDiagnosticChannelCompatShim = false, ...pluginOptions } = options;
  return unplugin.esbuild({
    ...pluginOptions,
    browser: useDiagnosticChannelCompatShim,
  });
}

export type EsbuildPluginOptions = LegacyBundlerPluginOptions;

/**
 * @deprecated Use {@link braintrustEsbuildPlugin} instead. This legacy export
 * defaults to browser-compatible diagnostics channel shimming when `browser`
 * is omitted; `braintrustEsbuildPlugin` defaults to Node.js diagnostics_channel
 * unless `useDiagnosticChannelCompatShim` is set to `true`.
 */
export const esbuildPlugin = unplugin.esbuild;
