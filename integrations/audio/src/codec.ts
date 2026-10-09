import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
/** Codec is loaded inside Braintrust's encoding worker, never on the voice thread. */
export function oggOpus() {
  return {
    module: pathToFileURL(
      join(
        dirname(
          createRequire(__filename).resolve("@braintrust/audio/package.json"),
        ),
        "dist/encoder.mjs",
      ),
    ).href,
  };
}
