#!/usr/bin/env node
// @ts-check
/**
 * Convenience wrapper for recording cassettes locally.
 *
 *   pnpm --filter=@braintrust/js-e2e-tests run test:e2e:record [-- vitest args]
 *
 * Sets BRAINTRUST_E2E_CASSETTE_MODE=record, which overwrites cassette files
 * with fresh recordings.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(SCRIPT_DIR, "..");

const args = process.argv.slice(2);

const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const env = {
  ...process.env,
  BRAINTRUST_E2E_CASSETTE_MODE: "record",
};

const child = spawn(PNPM, ["exec", "vitest", "run", ...args], {
  cwd: E2E_ROOT,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("close", (code) => {
  process.exit(code ?? 0);
});
