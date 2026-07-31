import type { VitePlugin } from "unplugin";
import { BundlerPluginOptions, unplugin } from "./plugin";
export type { InstrumentationConfig } from "../orchestrion-js";

export function braintrustVitePlugin(
  options: BundlerPluginOptions = {},
): VitePlugin | VitePlugin[] {
  return unplugin.vite(options);
}

export type VitePluginOptions = BundlerPluginOptions;

/**
 * @deprecated Use {@link braintrustVitePlugin} instead.
 */
export const vitePlugin = unplugin.vite;
