import { spawn, execSync } from "node:child_process";
import {
  displayTestResults,
  hasFailures,
} from "../../../shared/dist/index.mjs";

const PORT = 8800;
const MAX_RETRIES = 20;
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

async function runTest() {
  killPort(PORT);

  const wrangler = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--port", String(PORT)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      detached: process.platform !== "win32",
    },
  );

  let output = "";
  wrangler.stdout.on("data", (d) => (output += d));
  wrangler.stderr.on("data", (d) => (output += d));

  const killProcessTree = (signal) => {
    if (wrangler.pid == null) {
      return;
    }

    if (process.platform !== "win32") {
      try {
        process.kill(-wrangler.pid, signal);
        return;
      } catch {}
    }

    try {
      wrangler.kill(signal);
    } catch {}
  };

  const killWrangler = async () => {
    if (wrangler.exitCode === null) {
      killProcessTree("SIGTERM");
      await sleep(1000);
      if (wrangler.exitCode === null) {
        killProcessTree("SIGKILL");
        await sleep(250);
      }
    }
    killPort(PORT);
    wrangler.unref();
  };

  let exitCode = 1;

  try {
    if (!(await waitForServer(wrangler))) {
      console.error("Server failed to start:\n", output);
      await killWrangler();
      return 1;
    }

    const response = await fetch(`http://localhost:${PORT}/api/test`);
    const result = await response.json();

    if (result.results && result.results.length > 0) {
      displayTestResults({
        scenarioName: "Cloudflare Vite Hono Test Results",
        results: result.results,
      });
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

    exitCode = result.success ? 0 : 1;
  } catch (error) {
    console.error("Error:", error.message, "\n", output);
    exitCode = 1;
  }

  await killWrangler();
  return exitCode;
}

runTest().then((code) => process.exit(code));
