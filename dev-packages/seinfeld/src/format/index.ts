import type { CassetteFile } from "../cassette";
import { CassetteFormatError } from "../errors";
import { cassetteSchema } from "./v1";

/**
 * Parse a raw (JSON-deserialized) cassette object, dispatching to the correct
 * version schema. Throws `CassetteFormatError` for schema mismatches.
 */
export function parseCassette(
  raw: unknown,
  cassetteName: string,
): CassetteFile {
  const result = cassetteSchema.safeParse(raw);
  if (!result.success) {
    throw new CassetteFormatError({
      cassetteName,
      message: result.error.message,
    });
  }
  return result.data;
}
