import type { WebpackPluginInstance } from "unplugin";
import { BundlerPluginOptions, unplugin } from "./plugin";
export type { InstrumentationConfig } from "../orchestrion-js";

export function braintrustWebpackPlugin(
  options: BundlerPluginOptions = {},
): WebpackPluginInstance {
  return unplugin.webpack(options);
}
