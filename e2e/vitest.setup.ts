import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { initializeProdForwarding } from "./helpers/prod-forwarding";

// Load `.env` from the repo root (and `.env.local` if present, for
// developer-local overrides) into process.env so that local test runs and
// recordings can pick up provider keys without exporting them in the
// shell. Existing env values are preserved (override: false).
const setupDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(setupDir, "..");
loadDotenv({ path: path.join(repoRoot, ".env"), override: false, quiet: true });
loadDotenv({
  path: path.join(repoRoot, ".env.local"),
  override: false,
  quiet: true,
});

await initializeProdForwarding();
