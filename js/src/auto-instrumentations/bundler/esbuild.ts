import type { EsbuildPlugin } from "unplugin";
import { BundlerPluginOptions, unplugin } from "./plugin";

export function braintrustEsbuildPlugin(
  options: BundlerPluginOptions = {},
): EsbuildPlugin {
  return unplugin.esbuild(options);
}
