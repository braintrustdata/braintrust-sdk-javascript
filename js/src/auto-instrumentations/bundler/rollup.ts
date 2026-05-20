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
 * @deprecated Use {@link braintrustRollupPlugin} instead.
 */
export const rollupPlugin = unplugin.rollup;
