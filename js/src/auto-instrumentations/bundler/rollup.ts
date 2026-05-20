import type { RollupPlugin } from "unplugin";
import {
  BundlerPluginOptions,
  unplugin,
  type LegacyBundlerPluginOptions,
} from "./plugin";

export function braintrustRollupPlugin(
  options: BundlerPluginOptions = {},
): RollupPlugin | RollupPlugin[] {
  const { useDiagnosticChannelCompatShim = false, ...pluginOptions } = options;
  return unplugin.rollup({
    ...pluginOptions,
    browser: useDiagnosticChannelCompatShim,
  });
}

export type RollupPluginOptions = LegacyBundlerPluginOptions;

/**
 * @deprecated Use {@link braintrustRollupPlugin} instead. This legacy export
 * defaults to browser-compatible diagnostics channel shimming when `browser`
 * is omitted; `braintrustRollupPlugin` defaults to Node.js diagnostics_channel
 * unless `useDiagnosticChannelCompatShim` is set to `true`.
 */
export const rollupPlugin = unplugin.rollup;
