import { spawn, execSync } from "node:child_process";
import {
  displayTestResults,
  hasFailures,
} from "../../../shared/dist/index.mjs";

const PORT = 8801;
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

function displayResults(testResult) {
  if (testResult.results && testResult.results.length > 0) {
    displayTestResults({
      scenarioName: "Cloudflare Worker Browser Compat Test Results",
      results: testResult.results,
    });
  } else {
    console.log(JSON.stringify(testResult, null, 2));
  }
}

async function main() {
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

  let wranglerOutput = "";
  wrangler.stdout.on("data", (data) => (wranglerOutput += data));
  wrangler.stderr.on("data", (data) => (wranglerOutput += data));

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

  try {
    const serverStartedSuccessfully = await waitForServer(wrangler);

    if (!serverStartedSuccessfully) {
      console.error("Server failed to start:\n", wranglerOutput);
      await killWrangler();
      process.exit(1);
    }

    const testResponse = await fetch(`http://localhost:${PORT}/test`);
    const testResult = await testResponse.json();

    displayResults(testResult);

    const exitCode = testResult.success ? 0 : 1;
    await killWrangler();
    process.exit(exitCode);
  } catch (error) {
    console.error("Error:", error.message, "\n", wranglerOutput);
    await killWrangler();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
