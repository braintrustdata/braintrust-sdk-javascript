import { spawn, execSync } from "node:child_process";
import {
  displayTestResults,
  hasFailures,
} from "../../../shared/dist/index.mjs";

const PORT = 8802;
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

  const results = [];

  try {
    const serverStartedSuccessfully = await waitForServer(wrangler);

    if (!serverStartedSuccessfully) {
      results.push({
        status: "xfail",
        name: "Worker startup without nodejs_compat_v2",
        message:
          "Worker failed to start as expected (Node.js APIs require nodejs_compat_v2)",
      });
      await killWrangler();
    } else {
      results.push({
        status: "fail",
        name: "Worker startup without nodejs_compat_v2",
        error: {
          message:
            "Worker started successfully, but it should have failed! The Node.js entrypoint should not work without nodejs_compat_v2.",
        },
      });
      await killWrangler();
    }
  } catch (error) {
    results.push({
      status: "xfail",
      name: "Worker startup without nodejs_compat_v2",
      message: `Worker failed as expected: ${error.message}`,
    });
    await killWrangler();
  }

  displayTestResults({
    scenarioName: "Cloudflare Worker Node No Compat Test Results",
    results,
  });

  if (hasFailures(results)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
