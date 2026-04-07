#!/usr/bin/env node
/**
 * Test for Vite dev server compatibility with Braintrust SDK (browser build)
 *
 * This test verifies that Vite can successfully pre-bundle the browser build of Braintrust
 * and that the worker runs correctly with all test suites via vite dev server.
 * Should produce identical results to worker.test.mjs (19 pass, 1 xfail for nunjucks).
 */

import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { displayTestResults } from "../../../shared/dist/index.mjs";

const PORT = 5173;
const MAX_RETRIES = 40;
const RETRY_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killPort(port) {
  try {
    execSync(
      `lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`,
      {
        stdio: "ignore",
      },
    );
  } catch {}
}

async function waitForServer(serverProcess) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (serverProcess.exitCode !== null) {
      return false;
    }

    try {
      const res = await fetch(`http://localhost:${PORT}/`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return true;
    } catch {}
    await sleep(RETRY_DELAY_MS);
  }
  return false;
}

async function testViteDevServer() {
  killPort(PORT);

  // Clear Vite cache to force fresh dependency pre-bundling
  try {
    rmSync("node_modules/.vite", { recursive: true, force: true });
  } catch {}

  const vite = spawn("pnpm", ["exec", "vite", "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    detached: process.platform !== "win32",
  });

  let output = "";
  vite.stdout.on("data", (d) => (output += d));
  vite.stderr.on("data", (d) => (output += d));

  const killProcessTree = (signal) => {
    if (vite.pid == null) {
      return;
    }

    if (process.platform !== "win32") {
      try {
        process.kill(-vite.pid, signal);
        return;
      } catch {}
    }

    try {
      vite.kill(signal);
    } catch {}
  };

  const killVite = async () => {
    if (vite.exitCode === null) {
      killProcessTree("SIGTERM");
      await sleep(1000);
      if (vite.exitCode === null) {
        killProcessTree("SIGKILL");
        await sleep(250);
      }
    }
    killPort(PORT);
    vite.unref();
  };

  let exitCode = 1;

  try {
    if (!(await waitForServer(vite))) {
      await killVite();
      return 1;
    }

    const response = await fetch(`http://localhost:${PORT}/api/test`);
    const result = await response.json();

    if (result.results && result.results.length > 0) {
      displayTestResults({
        scenarioName: "Vite Dev Server - Browser Build Test",
        results: result.results,
      });
    }

    exitCode = result.success ? 0 : 1;
  } catch (error) {
    exitCode = 1;
  }

  await killVite();
  return exitCode;
}

testViteDevServer().then((code) => process.exit(code));
