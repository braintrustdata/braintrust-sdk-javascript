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
  private configs: InstrumentationConfig[] = [];
  private dcModule: string;
  private transformers: Record<string, Transformer> = {};

  constructor(configs: InstrumentationConfig[], dcModule?: string | null) {
    this.configs = configs;
    this.dcModule = dcModule || "diagnostics_channel";
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
    filePath = filePath.replace(/\\/g, "/");

    const id = `${moduleName}/${filePath}@${version}`;

    if (this.transformers[id]) {
      return this.transformers[id];
    }

    const configs = this.configs.filter(
      ({ module: mod }) =>
        mod.name === moduleName &&
        mod.filePath === filePath &&
        semifies(version, mod.versionRange),
    );

    if (configs.length === 0) {
      return undefined;
    }

    this.transformers[id] = new Transformer(
      moduleName,
      version,
      filePath,
      configs,
      this.dcModule,
    );

    return this.transformers[id];
  }

  free(): void {
    this.transformers = {};
  }
}
