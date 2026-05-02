/**
 * Versioned cassette format dispatcher.
 *
 * `parseCassette` reads the `version` field and routes to the appropriate
 * schema. Unknown fields at entry level are preserved via `.passthrough()` in
 * each version schema so minor additions within a major version survive
 * round-trips.
 *
 * Rule for bumping versions:
 * - New optional fields in an existing version: add to the schema with
 *   `.optional()`; no version bump needed (passthrough preserves them for
 *   older readers too).
 * - Breaking / required changes: add a `v2.ts` schema, add a migration in
 *   `migrateV1ToV2`, and bump `CURRENT_FORMAT_VERSION` there.
 */

import type { CassetteFile } from "../cassette";
import { CassetteFormatError, CassetteVersionError } from "../errors";
import { CURRENT_FORMAT_VERSION, cassetteSchema } from "./v1";

export { CURRENT_FORMAT_VERSION } from "./v1";

/**
 * Parse a raw (JSON-deserialized) cassette object, dispatching to the correct
 * version schema. Throws `CassetteVersionError` for unsupported versions and
 * `CassetteFormatError` for schema mismatches.
 */
export function parseCassette(
  raw: unknown,
  cassetteName: string,
): CassetteFile {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("version" in raw) ||
    typeof raw.version !== "number"
  ) {
    throw new CassetteFormatError({
      cassetteName,
      message: 'Missing or invalid "version" field',
    });
  }

  const version = (raw as { version: number }).version;

  if (version > CURRENT_FORMAT_VERSION) {
    throw new CassetteVersionError({
      cassetteName,
      foundVersion: version,
      supportedVersion: CURRENT_FORMAT_VERSION,
    });
  }

  // Route to version-specific schema. When v2 is added, add another branch.
  if (version === 1) {
    const result = cassetteSchema.safeParse(raw);
    if (!result.success) {
      throw new CassetteFormatError({
        cassetteName,
        message: result.error.message,
      });
    }
    return result.data;
  }

  // version < 1 — too old, no migration available
  throw new CassetteVersionError({
    cassetteName,
    foundVersion: version,
    supportedVersion: CURRENT_FORMAT_VERSION,
  });
}
