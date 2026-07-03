import type { EsbuildPlugin } from "unplugin";
import {
  BundlerPluginOptions,
  unplugin,
  type LegacyBundlerPluginOptions,
} from "./plugin";
export type { InstrumentationConfig } from "../orchestrion-js";

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
 * @deprecated Use {@link braintrustEsbuildPlugin} instead.
 */
export const esbuildPlugin = unplugin.esbuild;
