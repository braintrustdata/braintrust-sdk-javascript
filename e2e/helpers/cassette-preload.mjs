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
 *
 * The preload exits silently if the cassette path env var is not set, so
 * it's safe to install for scenarios that haven't migrated yet (the
 * harness only sets the env vars for opted-in scenarios).
 *
 * Per-scenario request-body filters live in `<scenario-dir>/cassette-filter.mjs`
 * (optional). The file should export a named `filter` conforming to the
 * seinfeld `FilterSpec` type. If absent, the seinfeld `"default"` preset is used.
 */
import * as path from "node:path";
import { createCassette, createJsonFileStore } from "@braintrust/seinfeld";

const CASSETTE_DIR = process.env.BRAINTRUST_E2E_CASSETTE_PATH;
const MODE_RAW = process.env.BRAINTRUST_E2E_CASSETTE_MODE ?? "replay";
const VARIANT_KEY = process.env.BRAINTRUST_E2E_CASSETTE_VARIANT ?? "default";
const MOCK_HOST = process.env.BRAINTRUST_E2E_MOCK_HOST;

if (CASSETTE_DIR) {
  await bootCassettePreload(CASSETTE_DIR);
}

/**
 * @param {string} cassetteDir  Absolute path to the __cassettes__ directory.
 */
async function bootCassettePreload(cassetteDir) {
  const mode = resolveMode(MODE_RAW);
  const filters = await loadScenarioFilter(cassetteDir);
  const passthroughHosts = MOCK_HOST ? [MOCK_HOST] : [];

  const cassette = createCassette({
    name: VARIANT_KEY,
    mode,
    store: createJsonFileStore({ rootDir: cassetteDir }),
    filters,
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
 * Try to load a per-scenario cassette filter from `<scenario-dir>/cassette-filter.mjs`.
 * Falls back to the seinfeld `"default"` preset if the file is absent.
 *
 * @param {string} cassetteDir  Absolute path to the __cassettes__ directory.
 * @returns {Promise<import("@braintrust/seinfeld").FilterSpec>}
 */
async function loadScenarioFilter(cassetteDir) {
  // cassetteDir is <scenario>/__cassettes__ — parent is the scenario root.
  const scenarioDir = path.resolve(cassetteDir, "..");
  const filterPath = path.join(scenarioDir, "cassette-filter.mjs");
  try {
    const mod = await import(filterPath);
    if (mod.filter !== undefined) {
      return mod.filter;
    }
  } catch {
    // File absent or not a valid module — fall through to default.
  }
  return "default";
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
