/**
 * Cassette preload module — runs in the e2e scenario subprocess via
 * `node --import=<this file>`. Boots seinfeld with a cassette that intercepts
 * provider HTTP traffic and replays or records it from/to a cassette JSON file.
 *
 * Env vars (set by the harness):
 *   BRAINTRUST_E2E_CASSETTE_PATH    — absolute path to the cassette directory
 *   BRAINTRUST_E2E_CASSETTE_MODE    — replay | record | passthrough
 *   BRAINTRUST_E2E_CASSETTE_VARIANT — variant key (cassette name, no extension)
 *   BRAINTRUST_E2E_MOCK_HOST        — host:port of the Braintrust mock server (always passthrough)
 *   BRAINTRUST_E2E_CASSETTE_NORMALIZER — name of the request-body filter to use
 *
 * The preload exits silently if the cassette path env var is not set, so
 * it's safe to install for scenarios that haven't migrated yet (the
 * harness only sets the env vars for opted-in scenarios).
 */
import { createCassette, createJsonFileStore } from "@braintrust/seinfeld";
import { CASSETTE_FILTERS } from "./cassette-filters.mjs";

const CASSETTE_DIR = process.env.BRAINTRUST_E2E_CASSETTE_PATH;
const MODE_RAW = process.env.BRAINTRUST_E2E_CASSETTE_MODE ?? "replay";
const VARIANT_KEY = process.env.BRAINTRUST_E2E_CASSETTE_VARIANT ?? "default";
const MOCK_HOST = process.env.BRAINTRUST_E2E_MOCK_HOST;
const NORMALIZER_NAME = process.env.BRAINTRUST_E2E_CASSETTE_NORMALIZER;

if (CASSETTE_DIR) {
  await bootCassettePreload(CASSETTE_DIR);
}

/**
 * @param {string} cassetteDir  Absolute path to the __cassettes__ directory.
 */
async function bootCassettePreload(cassetteDir) {
  const mode = resolveMode(MODE_RAW);
  const filters =
    CASSETTE_FILTERS[NORMALIZER_NAME ?? ""] ?? CASSETTE_FILTERS["default"];
  const passthroughHosts = MOCK_HOST ? [MOCK_HOST] : [];

  const cassette = createCassette({
    name: VARIANT_KEY,
    mode,
    store: createJsonFileStore({ rootDir: cassetteDir }),
    filters,
    redact: "paranoid",
    passthroughHosts,
    onMiss: (req) => {
      process.stderr.write(`[cassette] MISS: ${req.method} ${req.url}\n`);
    },
  });

  await cassette.start();

  process.on("beforeExit", async () => {
    try {
      await cassette.stop();
    } catch (err) {
      process.stderr.write(
        `[cassette] stop error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });
}

/**
 * @param {string} raw
 * @returns {import('@braintrust/seinfeld').CassetteMode}
 */
function resolveMode(raw) {
  if (raw === "record" || raw === "record-missing") return "record";
  if (raw === "passthrough") return "passthrough";
  return "replay";
}
