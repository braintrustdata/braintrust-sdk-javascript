/**
 * Cassette preload module — runs in the e2e scenario subprocess via
 * `node --import=<this file>`. Boots seinfeld with a cassette that intercepts
 * provider HTTP traffic and replays or records it from/to a cassette JSON file.
 *
 * Env vars (set by the harness):
 *   BRAINTRUST_E2E_CASSETTE_PATH    — absolute path to the cassette JSON
 *   BRAINTRUST_E2E_CASSETTE_MODE    — replay | record | passthrough
 *   BRAINTRUST_E2E_CASSETTE_VARIANT — variant key (cassette filename without .json)
 *   BRAINTRUST_E2E_MOCK_HOST        — host:port of the Braintrust mock server (always passthrough)
 *   BRAINTRUST_E2E_CASSETTE_NORMALIZER — name of the request-body filter to use
 *
 * The preload exits silently if the cassette path env var is not set, so
 * it's safe to install for scenarios that haven't migrated yet (the
 * harness only sets the env vars for opted-in scenarios).
 */
import { dirname } from "node:path";
import { createCassette, createJsonFileStore } from "@braintrust/seinfeld";
import { CASSETTE_FILTERS } from "./cassette-filters.mjs";

const CASSETTE_PATH = process.env.BRAINTRUST_E2E_CASSETTE_PATH;
const MODE_RAW = process.env.BRAINTRUST_E2E_CASSETTE_MODE ?? "replay";
const VARIANT_KEY = process.env.BRAINTRUST_E2E_CASSETTE_VARIANT ?? "default";
const MOCK_HOST = process.env.BRAINTRUST_E2E_MOCK_HOST;
const NORMALIZER_NAME = process.env.BRAINTRUST_E2E_CASSETTE_NORMALIZER;

if (!CASSETTE_PATH) {
  // Not opted in — proceed without interception.
  process.exit !== undefined; // no-op to satisfy linter (module loaded, not started)
} else {
  await bootCassettePreload(CASSETTE_PATH);
}

/**
 * @param {string} cassettePath
 */
async function bootCassettePreload(cassettePath) {
  /** @type {import('@braintrust/seinfeld').CassetteMode} */
  const mode = resolveMode(MODE_RAW);
  const rootDir = dirname(cassettePath);
  const filters =
    CASSETTE_FILTERS[NORMALIZER_NAME ?? ""] ?? CASSETTE_FILTERS["default"];

  /** @type {string[]} */
  const passthroughHosts = MOCK_HOST ? [MOCK_HOST] : [];

  const cassette = createCassette({
    name: VARIANT_KEY,
    mode,
    store: createJsonFileStore({ rootDir }),
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
