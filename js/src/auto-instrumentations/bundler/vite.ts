import type { VitePlugin } from "unplugin";
import {
  BundlerPluginOptions,
  unplugin,
  type LegacyBundlerPluginOptions,
} from "./plugin";
export type { InstrumentationConfig } from "../orchestrion-js";

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
 * @deprecated Use {@link braintrustVitePlugin} instead.
 */
export const vitePlugin = unplugin.vite;
