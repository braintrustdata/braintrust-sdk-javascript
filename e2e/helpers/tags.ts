import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_TAGS = {
  hermetic: "hermetic",
} as const;

export type E2ETag = (typeof E2E_TAGS)[keyof typeof E2E_TAGS];

/**
 * Resolve the directory that owns a scenario test file. Mirrors
 * `resolveScenarioDir` from `scenario-harness.ts` but is decoupled so
 * tag helpers can avoid an import cycle.
 */
function dirFromImportMetaUrl(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

function cassetteExists(scenarioDir: string, variantKey: string): boolean {
  return existsSync(
    path.join(scenarioDir, "__cassettes__", `${variantKey}.json`),
  );
}

/**
 * Returns `[E2E_TAGS.hermetic]` when a cassette file exists for the given
 * variant in the current scenario folder, otherwise an empty array.
 *
 * Use to conditionally tag tests as hermetic based on cassette presence,
 * so that scenarios automatically join the hermetic CI lane once cassettes
 * are recorded.
 *
 * Example:
 * ```ts
 * const tags = cassetteTagsFor(import.meta.url, "anthropic-v0273");
 * test("...", { tags }, async () => { ... });
 * ```
 */
export function cassetteTagsFor(
  importMetaUrl: string,
  variantKey: string,
): E2ETag[] {
  const scenarioDir = dirFromImportMetaUrl(importMetaUrl);
  return cassetteExists(scenarioDir, variantKey) ? [E2E_TAGS.hermetic] : [];
}

/**
 * Returns `[E2E_TAGS.hermetic]` only when cassettes exist for **all**
 * listed variant keys. Useful when a single `describe` block exercises
 * multiple variants (e.g. wrapped + auto-hook) and the suite should be
 * hermetic only once both variants have recordings.
 */
export function cassetteTagsForAll(
  importMetaUrl: string,
  variantKeys: readonly string[],
): E2ETag[] {
  if (variantKeys.length === 0) {
    return [];
  }
  const scenarioDir = dirFromImportMetaUrl(importMetaUrl);
  const allExist = variantKeys.every((variantKey) =>
    cassetteExists(scenarioDir, variantKey),
  );
  return allExist ? [E2E_TAGS.hermetic] : [];
}
