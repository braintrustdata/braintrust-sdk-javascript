import type { RollupPlugin } from "unplugin";
import { BundlerPluginOptions, unplugin } from "./plugin";
export type { InstrumentationConfig } from "../orchestrion-js";

export function braintrustRollupPlugin(
  options: BundlerPluginOptions = {},
): RollupPlugin | RollupPlugin[] {
  return unplugin.rollup(options);
}
