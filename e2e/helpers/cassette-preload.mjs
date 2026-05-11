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

  if (mode === "record") {
    installRecordModeGuard(cassette);
  } else {
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
}

/**
 * In record mode, `beforeExit` can fire in the gap between sequential HTTP
 * calls (e.g. ADK's two-step tool-call flow: first call returns a functionCall,
 * tool executes synchronously, then the second call sends the result). The gap
 * between calls has no pending I/O, so the event loop empties and `beforeExit`
 * fires prematurely — causing only a partial cassette to be saved.
 *
 * Fix: wrap `globalThis.fetch` (after MSW has installed its proxy) to track
 * in-flight request count. A drain timer is set after each request completes
 * and reset when the next request starts. `cassette.stop()` is only called
 * when the drain timer fires with no in-flight requests, guaranteeing all
 * sequential HTTP calls have been captured before we flush.
 *
 * @param {import("@braintrust/seinfeld").Cassette} cassette
 */
function installRecordModeGuard(cassette) {
  // How long to wait after the last HTTP call before flushing the cassette.
  // Must be long enough for the scenario to initiate the next sequential
  // request. For ADK tool-call flows, the event loop empties between calls
  // (MSW doesn't maintain a keep-alive socket) so the drain delay must be
  // large enough to cover any gap between sequential Gemini API calls.
  const DRAIN_DELAY_MS = 2000;

  const mswFetch = globalThis.fetch;
  let inFlight = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let drainTimer = null;
  let stopping = false;

  async function stopOnDrain() {
    if (stopping) return;
    if (inFlight > 0) return; // new request started before drain fired
    stopping = true;
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    try {
      await cassette.stop();
    } catch (err) {
      process.stderr.write(
        `[cassette] stop error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  function scheduleDrain() {
    if (stopping) return;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = setTimeout(stopOnDrain, DRAIN_DELAY_MS);
  }

  globalThis.fetch = async function recordGuardFetch(input, init) {
    // Cancel any pending drain — a new request is starting.
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    inFlight++;
    try {
      return await mswFetch(input, init);
    } finally {
      inFlight--;
      scheduleDrain();
    }
  };

  // Fallback: if the scenario makes no HTTP calls, still flush the cassette.
  process.on("beforeExit", async () => {
    await stopOnDrain();
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
