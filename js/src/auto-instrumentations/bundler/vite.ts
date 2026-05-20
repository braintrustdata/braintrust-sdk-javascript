import type { VitePlugin } from "unplugin";
import {
  BundlerPluginOptions,
  unplugin,
  type LegacyBundlerPluginOptions,
} from "./plugin";

export function braintrustVitePlugin(
  options: BundlerPluginOptions = {},
): VitePlugin | VitePlugin[] {
  const { useDiagnosticChannelCompatShim = false, ...pluginOptions } = options;
  return unplugin.vite({
    ...pluginOptions,
    browser: useDiagnosticChannelCompatShim,
  });
}

export type VitePluginOptions = LegacyBundlerPluginOptions;

/**
 * @deprecated Use {@link braintrustVitePlugin} instead. This legacy export
 * defaults to browser-compatible diagnostics channel shimming when `browser`
 * is omitted; `braintrustVitePlugin` defaults to Node.js diagnostics_channel
 * unless `useDiagnosticChannelCompatShim` is set to `true`.
 */
export const vitePlugin = unplugin.vite;
