import type { RollupPlugin } from "unplugin";
import { BundlerPluginOptions, unplugin } from "./plugin";

export function braintrustRollupPlugin(
  options: BundlerPluginOptions = {},
): RollupPlugin | RollupPlugin[] {
  return unplugin.rollup(options);
}
