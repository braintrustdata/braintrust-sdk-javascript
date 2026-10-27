/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import semifies from "semifies";
import { Transformer } from "./transformer";
import type { InstrumentationConfig } from "./types";

/**
 * Matches instrumentation configs against a given module/file/version triple and
 * returns a cached Transformer for matching configs.
 */
export class InstrumentationMatcher {
  private configs = new Map<string, InstrumentationConfig[]>();
  private transformers: Record<string, Transformer> = {};

  constructor(configs: InstrumentationConfig[]) {
    for (const config of configs) {
      const name = config.module.name;
      const packageConfigs = this.configs.get(name);
      if (packageConfigs) packageConfigs.push(config);
      else this.configs.set(name, [config]);
    }
  }

  /**
   * Returns a Transformer for the given module/file/version, or undefined if no
   * registered config matches.
   */
  getTransformer(
    moduleName: string,
    version: string,
    filePath: string,
  ): Transformer | undefined {
    const packageConfigs = this.configs.get(moduleName);
    if (!packageConfigs) return undefined;

    filePath = filePath.replace(/\\/g, "/");

    const id = `${moduleName}/${filePath}@${version}`;

    if (this.transformers[id]) {
      return this.transformers[id];
    }

    const configs = packageConfigs.filter(
      ({ module: mod }) =>
        mod.filePath === filePath && semifies(version, mod.versionRange),
    );

    if (configs.length === 0) {
      return undefined;
    }

    this.transformers[id] = new Transformer(
      moduleName,
      version,
      filePath,
      configs,
    );

    return this.transformers[id];
  }
}
