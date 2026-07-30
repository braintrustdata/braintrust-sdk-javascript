/**
 * Per-package source patches applied by the loaders.
 *
 * ⚠️ ANTI-PATTERN — DO NOT EXTEND CASUALLY.
 *
 * Every entry in this file represents a target SDK that doesn't expose a
 * stable extension point we can hook through diagnostics_channel + the
 * internal Orchestrion matcher. New integrations should
 * **prefer the standard channel-handler / `BasePlugin` pattern** used by
 * every other integration in `js/src/instrumentation/plugins/*-plugin.ts`.
 * Only add an entry here when the target SDK gives us no other option (e.g.
 * the SDK relies on side-effectful module initialization, exposes its API
 * exclusively as re-exports from content-hashed chunks, or otherwise can't
 * be cleanly instrumented via AST transformation).
 *
 * Each entry should be removable once the upstream package offers a
 * sanctioned extension contract. Track the upstream issue/PR in the comment
 * above each case.
 *
 *   - `openai` + `api-promise`: idempotent `.then()` wrap so `chat.completions
 *     .parse()` doesn't double-read the response body. Removable once OpenAI
 *     stops sharing the same `APIPromise` between `create()` and
 *     `_thenUnwrap()`.
 */

import { OPENAI_API_PROMISE_PATCH } from "./openai-api-promise-patch.js";

export type SpecialCaseFormat = "esm" | "cjs";

interface SpecialCaseInput {
  packageName: string;
  /** Forward-slash-normalized path inside the package, e.g. `dist/index.js`. */
  modulePath: string;
  /** Original module source as a string. */
  source: string;
  format: SpecialCaseFormat;
}

/**
 * Identify a target SDK that needs a one-off source patch and apply it.
 * Returns the patched source, or `null` if no entry matched (caller falls
 * through to the standard transformation pipeline).
 */
export function applySpecialCasePatch(input: SpecialCaseInput): string | null {
  // OpenAI: append idempotent .then() wrap to dist/api-promise.{m,c}js.
  if (
    input.packageName === "openai" &&
    input.modulePath.includes("api-promise")
  ) {
    return input.source + OPENAI_API_PROMISE_PATCH;
  }

  return null;
}

/**
 * Synchronous predicate variant used by the ESM resolve hook to decide
 * up-front whether a URL needs to be remembered for later patching. The
 * load step still calls `applySpecialCasePatch` against the actual source.
 */
export function isSpecialCaseTarget(
  packageName: string,
  modulePath: string,
): boolean {
  if (packageName === "openai" && modulePath.includes("api-promise")) {
    return true;
  }
  return false;
}
