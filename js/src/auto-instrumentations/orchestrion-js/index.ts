/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

import { InstrumentationMatcher } from "./matcher";
import type { InstrumentationConfig } from "./types";

/**
 * Creates a new InstrumentationMatcher from the given instrumentation configs.
 */
export function create(
  configs: InstrumentationConfig[],
  dcModule?: string | null,
): InstrumentationMatcher {
  return new InstrumentationMatcher(configs, dcModule);
}

export type { InstrumentationConfig, ModuleType } from "./types";
