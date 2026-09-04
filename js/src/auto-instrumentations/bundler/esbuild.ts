import type { EsbuildPlugin } from "unplugin";
import { BundlerPluginOptions, unplugin } from "./plugin";
export type { InstrumentationConfig } from "../orchestrion-js";

export function braintrustEsbuildPlugin(
  options: BundlerPluginOptions = {},
): EsbuildPlugin {
  return unplugin.esbuild(options);
}
