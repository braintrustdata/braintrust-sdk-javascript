import type { WebpackPluginInstance } from "unplugin";
import {
  BundlerPluginOptions,
  unplugin,
  type LegacyBundlerPluginOptions,
} from "./plugin";
export type { InstrumentationConfig } from "../orchestrion-js";

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
 * @deprecated Use {@link braintrustWebpackPlugin} instead.
 */
export const webpackPlugin = unplugin.webpack;
