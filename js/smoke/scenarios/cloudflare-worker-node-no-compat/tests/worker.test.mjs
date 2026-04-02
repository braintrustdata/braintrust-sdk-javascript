import { spawn, execSync } from "node:child_process";
import {
  displayTestResults,
  hasFailures,
} from "../../../shared/dist/index.mjs";

const PORT = 8802;
const MAX_RETRIES = 20;
const RETRY_DELAY_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killPort(port) {
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
      stdio: "ignore",
    });
  } catch {}
}

async function waitForServer() {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
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
    },
  );

  let wranglerOutput = "";
  wrangler.stdout.on("data", (data) => (wranglerOutput += data));
  wrangler.stderr.on("data", (data) => (wranglerOutput += data));

  const killWrangler = () => {
    return new Promise((resolve) => {
      if (wrangler.exitCode !== null) {
        resolve();
        return;
      }
      wrangler.once("exit", resolve);
      wrangler.kill("SIGTERM");
      setTimeout(() => {
        if (wrangler.exitCode === null) {
          wrangler.kill("SIGKILL");
        }
      }, 1000);
    });
  };

  const results = [];

  try {
    const serverStartedSuccessfully = await waitForServer();

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
