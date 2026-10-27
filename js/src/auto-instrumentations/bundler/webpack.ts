import type { WebpackPluginInstance } from "unplugin";
import { BundlerPluginOptions, unplugin } from "./plugin";

export function braintrustWebpackPlugin(
  options: BundlerPluginOptions = {},
): WebpackPluginInstance {
  return unplugin.webpack(options);
}
