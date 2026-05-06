#!/usr/bin/env node
// Run multiple pnpm scripts concurrently and exit non-zero if any fail.
// Cross-platform (works on Windows, macOS, Linux).
//
// Usage: node scripts/run-parallel.mjs <script1> [script2 ...]
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = process.argv.slice(2);
if (!scripts.length) {
  console.error("Usage: run-parallel.mjs <script1> [script2 ...]");
  process.exit(1);
}

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const results = await Promise.allSettled(
  scripts.map(
    (script) =>
      new Promise((resolve, reject) => {
        const child = spawn("pnpm", ["run", script], {
          cwd: pkgDir,
          stdio: "inherit",
          shell: true,
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve(script);
          } else {
            reject(new Error(`${script} exited with code ${code}`));
          }
        });
      }),
  ),
);

const failures = results.filter((r) => r.status === "rejected");
for (const f of failures) {
  console.error(f.reason.message);
}
if (failures.length > 0) {
  process.exit(1);
}
